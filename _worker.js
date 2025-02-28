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
  const debugMode = url.searchParams.has('debug');
  
  // Thêm debug log
  const debugLog = (message) => {
    if (debugMode) {
      console.log(`[DEBUG] ${message}`);
    }
  };
  
  debugLog(`Processing request for: ${url.pathname}`);
  
  // Kiểm tra nếu có query parameters, thì kiểm tra Referer
  const hasQueryParams = url.search !== '';
  if (hasQueryParams && !debugMode) {
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
  
  // Tạo clean URL cho R2 key (loại bỏ debug parameter)
  let cleanUrl = new URL(url);
  if (debugMode) {
    cleanUrl.searchParams.delete('debug');
  }
  
  const r2Key = cleanUrl.pathname + (cleanUrl.search || '');
  debugLog(`R2 key: ${r2Key}`);
  
  // Skip cache nếu đang ở chế độ debug
  if (!debugMode) {
    // Kiểm tra Cloudflare Cache
    debugLog(`Checking Cloudflare cache`);
    const cache = caches.default;
    let cachedResponse = await cache.match(request);
    if (cachedResponse) {
      debugLog(`Cache HIT - Serving from Cloudflare cache`);
      return cachedResponse;
    }
    debugLog(`Cache MISS`);
  } else {
    debugLog(`Debug mode: Skipping cache check`);
  }
  
  const rule = Object.entries(rules).find(([prefix]) => url.pathname.startsWith(prefix));
  if (!rule) {
    return new Response(`Path not supported: ${url.pathname}`, { status: 404 });
  }
  
  const [prefix, config] = rule;
  debugLog(`Using rule for prefix: ${prefix}, service: ${config.service}`);
  
  // Thử lấy ảnh từ R2
  try {
    debugLog(`Attempting to fetch from R2: ${r2Key}`);
    const r2Object = await env.IMAGES_BUCKET.get(r2Key);
    
    if (r2Object) {
      debugLog(`R2 HIT - Object found in R2`);
      const contentType = r2Object.httpMetadata?.contentType || "image/webp";
      debugLog(`Content-Type from R2: ${contentType}`);
      
      const headers = new Headers();
      headers.set("content-type", contentType);
      headers.set("cache-control", "public, max-age=31536000");
      headers.set("vary", "Accept");
      headers.set('X-Served-By', `Cloudflare R2 & ${config.service}`);
      
      const response = new Response(r2Object.body, { 
        headers: headers
      });
      
      // Cache response
      if (!debugMode) {
        debugLog(`Caching R2 response in Cloudflare cache`);
        const cache = caches.default;
        context.waitUntil(cache.put(request, response.clone()));
      }
      
      return response;
    } else {
      debugLog(`R2 MISS - Object not found in R2`);
    }
  } catch (error) {
    console.error(`R2 error: ${error.message}`);
    debugLog(`R2 ERROR: ${error.message}`);
    // Nếu R2 lỗi, tiếp tục lấy từ nguồn gốc
  }
  
  // Nếu không có trong R2, lấy từ nguồn gốc (Jetpack)
  debugLog(`Fetching from origin: ${config.targetHost}`);
  const targetUrl = new URL(url);
  targetUrl.hostname = config.targetHost;
  targetUrl.pathname = config.pathTransform(url.pathname, prefix);
  if (debugMode) {
    targetUrl.searchParams.delete('debug');
  } else {
    targetUrl.search = url.search;
  }
  
  debugLog(`Origin URL: ${targetUrl.toString()}`);
  const originResponse = await fetch(targetUrl, {
    headers: { 'Accept': request.headers.get('Accept') || '*/*' }
  });
  
  if (!originResponse.ok) {
    debugLog(`Origin responded with status: ${originResponse.status}`);
    return originResponse;
  }
  
  // Lấy content-type
  const contentType = originResponse.headers.get('content-type') || "image/webp";
  debugLog(`Content-Type from origin: ${contentType}`);
  
  // Clone response để lưu vào R2
  const responseClone = originResponse.clone();
  
  // Lưu vào R2
  debugLog(`Saving to R2 with key: ${r2Key}`);
  const r2Promise = responseClone.arrayBuffer().then(buffer => {
    debugLog(`Got arrayBuffer with ${buffer.byteLength} bytes`);
    return env.IMAGES_BUCKET.put(r2Key, buffer, {
      httpMetadata: {
        contentType: contentType
      }
    }).then(() => {
      debugLog(`Successfully saved to R2`);
    });
  }).catch(error => {
    console.error(`Error saving to R2: ${error.message}`);
    debugLog(`ERROR saving to R2: ${error.message}`);
  });
  
  // Create response với headers của origin
  const headers = new Headers(originResponse.headers);
  headers.set("cache-control", "public, max-age=31536000");
  headers.set("vary", "Accept");
  headers.set('X-Served-By', `Cloudflare Pages & ${config.service} (first load)`);
  
  const response = new Response(originResponse.body, { 
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: headers
  });
  
  // Cache response và lưu vào R2
  if (!debugMode) {
    debugLog(`Caching origin response in Cloudflare cache`);
    const cache = caches.default;
    const cachePromise = cache.put(request, response.clone());
    
    // Đợi cả hai promise hoàn thành
    context.waitUntil(Promise.all([r2Promise, cachePromise]));
  } else {
    context.waitUntil(r2Promise);
  }
  
  debugLog(`Returning origin response`);
  return response;
}

export default {
  async fetch(request, event, context, env) {
    try {
      // Xóa cache nếu có request thêm nocache
      const url = new URL(request.url);
      if (url.searchParams.has('nocache')) {
        const cacheKey = new URL(request.url);
        cacheKey.searchParams.delete('nocache');
        const cacheRequest = new Request(cacheKey.toString(), request);
        const cache = caches.default;
        await cache.delete(cacheRequest);
        url.searchParams.delete('nocache');
        return Response.redirect(url.toString(), 302);
      }
      
      let response = await serveAsset(request, event, context, env);
      if (!response || response.status > 399) {
        response = new Response(response.statusText || "Error occurred", { status: response.status });
      }
      return response;
    } catch (error) {
      console.error(`Global error: ${error.message}`);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};
