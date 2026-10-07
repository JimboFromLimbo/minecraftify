// Maps the many size/format/crop variants of one listing photo to a single id,
// so a photo is generated once and reused everywhere (thumbnail, hero, gallery,
// fullscreen). Shared by content.js and background.js.

(() => {
  // Size/format query params some CDNs use; stripped for the generic fallback.
  const SIZE_PARAMS = /^(w|h|width|height|size|q|quality|fit|crop|resize|format|fm|auto|dpr|im)$/i;

  const RULES = [
    {
      // realestate.com.au: i2.au.reastatic.net/<transform>/<sha256>/image.jpg
      re: /reastatic\.net\/(?:[^/]+\/)?([0-9a-f]{64})\/image\.(?:jpe?g|webp|avif)/i,
      id: (m) => `rea:${m[1]}`,
      // One consistent, reasonably large source regardless of which variant we saw.
      src: (m) => `https://i2.au.reastatic.net/1000x750/${m[1]}/image.jpg`,
      dims: (url) => {
        const d = url.match(/reastatic\.net\/(\d+)x(\d+)/);
        return d ? { w: +d[1], h: +d[2] } : null;
      },
    },
    {
      // Zillow: photos.zillowstatic.com/fp/<hash>-<variant>.<ext>
      re: /zillowstatic\.com\/fp\/([0-9a-f]{20,})-/i,
      id: (m) => `zillow:${m[1]}`,
    },
    {
      // Rightmove: ..._max_656x437.jpeg is a resize of the same file
      re: /(media\.rightmove\.co\.uk\/.*?)(?:_max_\d+x\d+)?\.(jpe?g|png|webp)/i,
      id: (m) => `rightmove:${m[1].replace(/\/dir\/crop\/[^/]+\//, "/")}`,
    },
    {
      // Zoopla: lid.zoocdn.com/u/<w>/<h>/<hash>.jpg or /<w>/<h>/<hash>.jpg
      re: /zoocdn\.com\/(?:u\/)?\d+\/\d+\/([^/?#]+)/i,
      id: (m) => `zoopla:${m[1].replace(/\.\w+$/, "")}`,
    },
  ];

  function photoInfo(url) {
    for (const r of RULES) {
      const m = url.match(r.re);
      if (m) return { id: r.id(m), src: r.src ? r.src(m) : url, dims: r.dims?.(url) || null };
    }
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (SIZE_PARAMS.test(k)) u.searchParams.delete(k);
      u.hash = "";
      return { id: u.href, src: url, dims: null };
    } catch {
      return { id: url, src: url, dims: null };
    }
  }

  globalThis.photoInfo = photoInfo;
})();
