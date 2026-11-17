/* upload-fix.js — replaces the narrow upload handler in The Apex Ai.
   Accepts any image/* (incl. GIF, BMP, AVIF, HEIC where the browser can decode),
   PDFs by MIME, extension, or file-header sniff, and keeps a fallback to the
   original handler so a failure here can never lose the feature. */
(function () {
  "use strict";

  var WEB_SAFE = { "image/png": 1, "image/jpeg": 1, "image/jpg": 1, "image/webp": 1 };
  var IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
  var MAX_BYTES = 8 * 1024 * 1024;
  var MAX_SIDE = 1568;
  var originalHandler = typeof window.handleFileSelected === "function" ? window.handleFileSelected : null;

  function fail(title, desc) {
    if (typeof window.showModal === "function") window.showModal(title, desc);
    else alert(title + "\n\n" + desc);
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(r.error || new Error("read failed")); };
      r.readAsDataURL(file);
    });
  }

  function readAsTextFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(r.error || new Error("read failed")); };
      r.readAsText(file);
    });
  }

  function startsWith(bytes, sig, at) {
    var offset = at || 0;
    for (var i = 0; i < sig.length; i++) {
      if (bytes[offset + i] !== sig[i]) return false;
    }
    return true;
  }

  var ASCII = function (s) {
    return s.split("").map(function (c) { return c.charCodeAt(0); });
  };

  /* Reads the first bytes of the file and works out what it really is.
     Android hands over plenty of files with no MIME type and no extension. */
  async function sniffKind(file) {
    var bytes = null;
    try {
      var buf = await file.slice(0, 16).arrayBuffer();
      bytes = new Uint8Array(buf);
    } catch (e) {
      try {
        var head = await file.slice(0, 5).text();
        return String(head || "").indexOf("%PDF-") === 0 ? "pdf" : null;
      } catch (e2) {
        return null;
      }
    }
    if (!bytes || bytes.length < 4) return null;

    if (startsWith(bytes, ASCII("%PDF-"))) return "pdf";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image";          // JPEG
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image";    // PNG
    if (startsWith(bytes, ASCII("GIF8"))) return "image";               // GIF
    if (startsWith(bytes, ASCII("RIFF")) && startsWith(bytes, ASCII("WEBP"), 8)) return "image";
    if (startsWith(bytes, ASCII("BM"))) return "image";                 // BMP
    if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return "image";    // TIFF little-endian
    if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image";    // TIFF big-endian
    if (startsWith(bytes, ASCII("ftyp"), 4)) return "image";            // HEIC / HEIF / AVIF
    return null;
  }

  function normalizeToJpeg(file) {
    return readAsDataUrl(file).then(function (raw) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          try {
            var iw = img.naturalWidth || img.width;
            var ih = img.naturalHeight || img.height;
            var scale = Math.min(1, MAX_SIDE / Math.max(iw, ih));
            var w = Math.max(1, Math.round(iw * scale));
            var h = Math.max(1, Math.round(ih * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.88));
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = function () { reject(new Error("decode failed")); };
        img.src = raw;
      });
    });
  }

  async function detect(file) {
    var mime = String(file.type || "").toLowerCase();
    var name = String(file.name || "").toLowerCase();
    if (mime.indexOf("image/") === 0 || IMAGE_EXT.test(name)) return { mime: mime, kind: "image" };
    if (mime === "application/pdf" || /\.pdf$/.test(name)) return { mime: mime, kind: "pdf" };
    if (mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream") {
      var sniffed = await sniffKind(file);
      if (sniffed) return { mime: mime, kind: sniffed };
    }
    return { mime: mime, kind: "unknown" };
  }

  async function hardened(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var info = await detect(file);

      if (info.kind === "image") {
        try {
          var dataUrl = (WEB_SAFE[info.mime] && file.size <= MAX_BYTES)
            ? await readAsDataUrl(file)
            : await normalizeToJpeg(file);
          attachedFiles.push({ type: "image", name: file.name || "image.jpg", dataUrl: dataUrl });
          renderFilePreviews();
        } catch (err) {
          fail("Could Not Read Image", "\"" + (file.name || "That file") + "\" could not be opened in this browser. HEIC/HEIF photos from some phone cameras need converting to JPEG or PNG first.");
        }
        continue;
      }

      if (info.kind === "pdf") {
        try {
          var text = await extractPdfText(file);
          var label = file.name || "document.pdf";
          attachedFiles.push({
            type: "text",
            name: label,
            content: "--- Attached PDF: " + label + " ---\n" + (text || "[No extractable text found in this PDF.]")
          });
          renderFilePreviews();
        } catch (err) {
          fail("PDF Error", "Could not read text from \"" + (file.name || "that PDF") + "\". A scanned PDF may have no text layer.");
        }
        continue;
      }

      try {
        var content = await readAsTextFile(file);
        if (/\u0000/.test(content)) {
          fail("Unsupported File", "\"" + (file.name || "That file") + "\" is a binary file, not text. Supported: images, PDFs, and text/code files.");
          continue;
        }
        attachedFiles.push({ type: "text", name: file.name || "file.txt", content: content });
        renderFilePreviews();
      } catch (err) {
        fail("Could Not Read File", "\"" + (file.name || "That file") + "\" could not be read on this device.");
      }
    }
  }

  window.handleFileSelected = async function (e) {
    try {
      await hardened(e);
    } catch (err) {
      if (originalHandler) return originalHandler(e);
      fail("Upload Failed", "That file could not be attached. Please try a different file.");
      if (typeof console !== "undefined" && console.warn) console.warn("[upload-fix]", err);
    }
  };

  var input = document.getElementById("deviceFileInput");
  if (input) {
    input.setAttribute(
      "accept",
      "image/*,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.heic,.heif,.pdf,.txt,.js,.py,.html,.css,.json,.csv,.md"
    );
  }
})();
