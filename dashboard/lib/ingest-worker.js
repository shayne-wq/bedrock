// Bedrock — ingest worker.
//
// A gigabyte-scale pass cannot run on the main thread: the tab would be frozen
// for the whole extraction and the browser would offer to kill it. The File is
// structured-cloneable, so it is handed over whole and streamed here.

import { probe, extract, pack, linesOf } from "./extract.js";

const lines = (file) => linesOf(file.stream());

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === "probe") {
      const p = await probe(lines(msg.file));
      // The header can be thousands of columns; it is needed for the mapping UI
      // but the sample arrays are not, so only the summary crosses back.
      self.postMessage({ ok: true, cmd: "probe", probe: p });
      return;
    }

    if (msg.cmd === "extract") {
      const out = await extract(lines(msg.file), {
        mapping: msg.mapping,
        dx: msg.dx, dy: msg.dy, dz: msg.dz,
        density: msg.density,
        cutoff: msg.cutoff || 0,
        onProgress: (rows) => self.postMessage({ cmd: "progress", rows }),
      });
      const buf = pack(out.columns);
      // Transferred, not copied — a second copy of a 4 MB buffer is avoidable
      // and on a larger deposit it would not be.
      self.postMessage({
        ok: true, cmd: "extract",
        stats: out.stats, buckets: out.buckets,
        reconciled: out.reconciled, packed: buf,
      }, [buf]);
      return;
    }

    throw new Error(`unknown command ${msg.cmd}`);
  } catch (err) {
    self.postMessage({ ok: false, cmd: msg.cmd, error: String(err?.message || err) });
  }
};
