const rules = {
  '/avatar': {
    targetHost: 'secure.gravatar.com',
    pathTransform: (path, prefix) => '/avatar' + path.replace(prefix, ''),
    service: 'Gravatar'
  },
  '/comment': {
    targetHost: 'i0.wp.com',
    pathTransform: (path, prefix) => '/comment.bibica.net/static/images' + path.replace(prefix, ''),
    service: 'Artalk & Jetpack'
  },
  '/': {
    targetHost: 'i0.wp.com',
    pathTransform: (path) => '/bibica.net/wp-content/uploads' + path,
    service: 'Jetpack'
  }
};

async function serveAsset(request, event, context, env) {
  const url = new URL(request.url);
  
  // Kiểm tra nếu có query parameters, thì kiểm tra Referer
  const hasQueryParams = url.search !== '';
  if (hasQueryParams) {
    const referer = request.headers.get('Referer');
    const allowedDomains = ['bibica.net', 'static.bibica.net', 'comment.bibica.net'];
    
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        if (!allowedDomains.includes(refererUrl.hostname)) {
          return new Response(`Access denied: Requests from ${refererUrl.hostname} are not allowed.`, {
            status: 403,
            headers: {
              'Cache-Control': 'no-store'
            }
          });
        }
      } catch (error) {
        return new Response('Access denied: Invalid Referer header.', {
          status: 403,
          headers: {
            'Cache-Control': 'no-store'
          }
        });
      }
    } else {
      return new Response('Access denied: Referer header is missing.', {
        status: 403,
        headers: {
          'Cache-Control': 'no-store'
        }
      });
    }
  }
  
  // Tạo key cho R2, dựa trên path gốc
  const r2Key = url.pathname + (url.search || '');
  
  // Kiểm tra xem có force reload từ source không
  const forceReload = url.searchParams.has('force');
  
  // Kiểm tra Cloudflare Cache nếu không force reload
  if (!forceReload) {
    const cache = caches.default;
    let cachedResponse = await cache.match(request);
    if (cachedResponse) {
      return new Response(cachedResponse.body, {
        headers: new Headers(cachedResponse.headers),
        status: cachedResponse.status
      });
    }
  }
  
  const rule = Object.entries(rules).find(([prefix]) => url.pathname.startsWith(prefix));
  if (!rule) {
    return new Response(`Path not supported: ${url.pathname}`, { status: 404 });
  }
  
  const [prefix, config] = rule;
  
  // Thử lấy ảnh từ R2 trước, trừ khi force reload
  if (!forceReload) {
    try {
      console.log(`Trying to fetch from R2: ${r2Key}`);
      const r2Object = await env.IMAGES_BUCKET.get(r2Key);
      
      if (r2Object) {
        console.log(`Successfully fetched from R2: ${r2Key}`);
        const headers = new Headers();
        headers.set("content-type", r2Object.httpMetadata.contentType || "image/webp");
        headers.set("cache-control", "public, max-age=31536000");
        headers.set("vary", "Accept");
        headers.set('X-Served-By', `Cloudflare R2 & ${config.service}`);
        
        const response = new Response(r2Object.body, { 
          headers: headers
        });
        
        // Cache response
        const cache = caches.default;
        context.waitUntil(cache.put(request, response.clone()));
        return response;
      } else {
        console.log(`Object not found in R2: ${r2Key}`);
      }
    } catch (error) {
      console.error(`R2 error for ${r2Key}:`, error);
      // Nếu R2 lỗi, tiếp tục lấy từ nguồn gốc
    }
  }
  
  // Nếu không có trong R2 hoặc force reload, lấy từ nguồn gốc (Jetpack)
  console.log(`Fetching from origin for: ${r2Key}`);
  const targetUrl = new URL(request.url);
  targetUrl.hostname = config.targetHost;
  targetUrl.pathname = config.pathTransform(url.pathname, prefix);
  targetUrl.search = url.search;
  
  const originResponse = await fetch(targetUrl, {
    headers: { 'Accept': request.headers.get('Accept') || '*/*' }
  });
  
  if (!originResponse.ok) {
    return originResponse;
  }
  
  // Clone response để lưu vào R2
  const responseClone = originResponse.clone();
  const contentType = originResponse.headers.get('content-type') || "image/webp";
  
  // Lưu vào R2 (giữ nguyên content-type từ response)
  context.waitUntil(
    responseClone.arrayBuffer().then(buffer => {
      console.log(`Saving to R2: ${r2Key} as ${contentType}`);
      return env.IMAGES_BUCKET.put(r2Key, buffer, {
        httpMetadata: {
          contentType: contentType
        }
      });
    }).catch(error => {
      console.error(`Error saving to R2 for ${r2Key}:`, error);
    })
  );
  
  const headers = new Headers(originResponse.headers);
  headers.set("cache-control", "public, max-age=31536000");
  headers.set("vary", "Accept");
  headers.set('X-Served-By', `Cloudflare Pages & ${config.service} (first load)`);
  
  const finalResponse = new Response(originResponse.body, { 
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: headers
  });
  
  // Cache response
  const cache = caches.default;
  context.waitUntil(cache.put(request, finalResponse.clone()));
  
  return finalResponse;
}

export default {
  async fetch(request, event, context, env) {
    try {
      let response = await serveAsset(request, event, context, env);
      if (!response || response.status > 399) {
        response = new Response(response.statusText || "Error occurred", { status: response.status });
      }
      return response;
    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};
