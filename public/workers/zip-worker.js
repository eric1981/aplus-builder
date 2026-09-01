/**
 * ZIP 打包 Web Worker
 *
 * 在后台线程生成 ZIP，避免 5MB+ 数据阻塞主线程 UI。
 * 用法：postMessage({ images: [{name, base64?, url?}], html: string })
 *   - url 存在时 fetch 原图（高清下载）；否则用 base64（缩略图回退）
 * 接收：{ type: "progress", processed, total, percent? }
 *       { type: "complete", blob: Blob }
 *       { type: "error", error: string }
 */

importScripts("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");

self.onmessage = async function (e) {
  const { images, html } = e.data;

  try {
    const zip = new JSZip();

    // 添加 HTML
    if (html) {
      zip.file("aplus-detail.html", html);
    }

    const total = images.length;

    // 添加图片（分批报告进度）
    for (let i = 0; i < total; i++) {
      const img = images[i];
      if (img.url) {
        // 原图 URL：worker 内 fetch（同源请求带 cookie），失败则回退 base64
        try {
          const res = await fetch(img.url);
          if (res.ok) {
            const blob = await res.blob();
            zip.file(img.name, blob);
            self.postMessage({ type: "progress", processed: i + 1, total });
            continue;
          }
        } catch {}
      }
      if (img.base64) {
        zip.file(img.name, img.base64, { base64: true });
      }
      self.postMessage({ type: "progress", processed: i + 1, total });
    }

    // 生成 ZIP blob，带压缩进度
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (meta) => {
        self.postMessage({
          type: "progress",
          processed: total,
          total,
          percent: Math.round(meta.percent),
        });
      }
    );

    self.postMessage({ type: "complete", blob });
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
