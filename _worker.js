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
    const allowedDomains = ['bibica.net', 'static.bibica.net', 'comment.bibica.net', 'jetpack-cf-r2-cache-v2.pages.dev'];
    
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
  
  // Kiểm tra Cloudflare Cache
  const cache = caches.default;
  let response = await cache.match(request);
  if (response) {
    return response;
  }
  
  const rule = Object.entries(rules).find(([prefix]) => url.pathname.startsWith(prefix));
  if (!rule) {
    return new Response(`Path not supported: ${url.pathname}`, { status: 404 });
  }
  
  const [prefix, config] = rule;
  
  // Tạo key cho R2, dựa trên path gốc
  const r2Key = url.pathname + (url.search || '');
  
  // Thử lấy ảnh từ R2 trước
  try {
    const r2Object = await env.IMAGES_BUCKET.get(r2Key);
    if (r2Object) {
      const headers = new Headers();
      headers.set("content-type", "image/webp"); // Mặc định là webp cho ảnh từ R2
      headers.set("cache-control", "public, max-age=31536000");
      headers.set("vary", "Accept");
      headers.set('X-Served-By', `Cloudflare R2 & ${config.service}`);
      
      response = new Response(r2Object.body, { 
        headers: headers
      });
      
      // Cache response
      context.waitUntil(cache.put(request, response.clone()));
      return response;
    }
  } catch (error) {
    console.error("R2 error:", error);
    // Nếu R2 lỗi, tiếp tục lấy từ nguồn gốc
  }
  
  // Nếu không có trong R2, lấy từ nguồn gốc (Jetpack)
  const targetUrl = new URL(request.url);
  targetUrl.hostname = config.targetHost;
  targetUrl.pathname = config.pathTransform(url.pathname, prefix);
  targetUrl.search = url.search;
  
  response = await fetch(targetUrl, {
    headers: { 'Accept': request.headers.get('Accept') || '*/*' }
  });
  
  if (!response.ok) {
    return response;
  }
  
  // Clone response để lưu vào R2
  const responseClone = response.clone();
  
  // Lưu vào R2 (giữ nguyên content-type)
  context.waitUntil(
    responseClone.arrayBuffer().then(buffer => {
      return env.IMAGES_BUCKET.put(r2Key, buffer, {
        httpMetadata: {
          contentType: "image/webp" // Mặc định lưu vào R2 dưới dạng webp
        }
      });
    }).catch(error => {
      console.error("Error saving to R2:", error);
    })
  );
  
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=31536000");
  headers.set("vary", "Accept");
  headers.set('X-Served-By', `Cloudflare Pages & ${config.service} (first load)`);
  
  response = new Response(response.body, { ...response, headers });
  context.waitUntil(cache.put(request, response.clone()));
  
  return response;
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
