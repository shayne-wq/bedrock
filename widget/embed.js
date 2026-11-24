/* The snippet an issuer puts on their own website.
 *
 *   <div data-bedrock-drill
 *        data-t="SHARE_TOKEN"
 *        data-api="https://<ref>.supabase.co"
 *        data-terrain="forest"></div>
 *   <script src="https://getbedrock.ca/widget/embed.js" async></script>
 *
 * It exists for one reason: an iframe cannot paint outside its own box. The
 * card inside asks to be taller when somebody opens it, and this is what
 * listens. Everything else it does is defensive — the card works without this
 * file, it just expands inside whatever height the page gave it.
 */
(function () {
  "use strict";

  var ORIGIN = (function () {
    // The origin this script was served from, so the frame it creates points
    // at the same deployment. Hard-coding getbedrock.ca here would break every
    // preview deployment and every local test, silently, by loading production
    // into a page that is testing something else.
    var s = document.currentScript;
    if (s && s.src) { try { return new URL(s.src).origin; } catch (e) { /* fall through */ } }
    return "https://getbedrock.ca";
  })();

  function mount(host) {
    if (host.getAttribute("data-bedrock-mounted") === "1") return;
    var t = host.getAttribute("data-t");
    var api = host.getAttribute("data-api");
    if (!t || !api) {
      // Said out loud rather than failing silently: a share link with no api
      // base has broken every viewer embed once already, and an empty box on a
      // live investor page is a bug nobody reports because nobody sees it.
      if (window.console) {
        console.error("[bedrock] the drilling card needs data-t and data-api.");
      }
      return;
    }
    host.setAttribute("data-bedrock-mounted", "1");

    var q = "?t=" + encodeURIComponent(t) + "&api=" + encodeURIComponent(api);
    var pass = ["p", "terrain", "forecast"];
    for (var i = 0; i < pass.length; i++) {
      var v = host.getAttribute("data-" + pass[i]);
      if (v) q += "&" + pass[i] + "=" + encodeURIComponent(v);
    }

    var f = document.createElement("iframe");
    f.src = ORIGIN + "/widget/" + q;
    f.title = "Drilling progress";
    f.loading = "lazy";
    f.setAttribute("scrolling", "no");
    // No allow-scripts escape hatch beyond what it needs: this frame runs our
    // code on their page, and the narrower the grant the easier that is for
    // their own security review to wave through.
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    f.style.cssText = "display:block;width:100%;border:0;overflow:hidden;" +
      "transition:height 420ms cubic-bezier(.22,.61,.36,1)";
    // A sensible 16:9 before the card has measured itself, so the page does not
    // reflow around a zero-height frame on first paint.
    f.style.height = Math.round((host.clientWidth || 360) * 9 / 16) + "px";
    host.appendChild(f);

    window.addEventListener("message", function (e) {
      if (!e.data || e.data.source !== "bedrock-drill") return;
      if (e.source !== f.contentWindow) return;      // only our own frame
      var h = Number(e.data.height);
      if (!isFinite(h) || h < 40 || h > 4000) return;
      f.style.height = Math.round(h) + "px";
    });
  }

  function scan() {
    var all = document.querySelectorAll("[data-bedrock-drill]");
    for (var i = 0; i < all.length; i++) mount(all[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
  // Hosts that render their sidebar after load — most CMS templates do — get
  // picked up without needing to call anything.
  if (window.MutationObserver) {
    new MutationObserver(scan).observe(document.documentElement,
      { childList: true, subtree: true });
  }
  window.bedrockDrill = { scan: scan };
})();
