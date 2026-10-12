import assert from "node:assert/strict";
import test from "node:test";
import { validateHtmlOutput } from "../../services/api/src/generation";
import { assessArtifact } from "./artifact-eval.mjs";

const validHtml =
  '<!doctype html><html lang="en-SG"><head><meta name="viewport" content="width=device-width"><title>Test</title><style>button{min-height:44px}</style></head><body><button>Try</button><script>document.querySelector("button").onclick=()=>{}</script></body></html>';

// Tricky inputs where the eval's HTML check once disagreed with production.
const snippets = [
  '<img alt="" src="https://outside.invalid/a.png">',
  '<img alt="" src="assets/image-1">',
  '<img alt="" src="">',
  '<a href="">Empty</a>',
  '<a href="#top">Top</a>',
  '<a href="data:text/html,hi">Data</a>',
  '<img alt="" src="data:image/png;base64,AAAA">',
  '<img alt="" src="data:image/svg+xml,<svg></svg>">',
  '<form action="#"></form>',
  '<img alt="" srcset="assets/image-1 1x">',
  '<video poster="assets/image-1"></video>',
  '<svg><use\nxlink:href="https://outside.invalid/a.svg#i"/></svg>',
  '<svg><use xlink:href="#i"/></svg>',
  '<p>\nhref="https://outside.invalid"</p>',
  '<p>(src="https://outside.invalid")</p>',
  '<iframe srcdoc="hi"></iframe>',
  '<style>.a{fill:url(#gradient)}</style>',
  '<style>.a{background:url(assets/image-1)}</style>',
  '<button data-action="check" data-src="https://outside.invalid">Go</button>',
  '<script data-src="pool-1">const pool = 1;</script>',
  "<script>const action = 1; let src = 2; var poster = 3; var href = 4;</script>",
  '<script>\nsrc = "https://outside.invalid";\n</script>',
  '<script>const image = new Image(); image.src = "https://outside.invalid/a.png";</script>',
  '<script>el.poster = "assets/image-1";</script>',
  '<script>el.setAttribute("srcset", "assets/image-1 1x");</script>',
  '<script>const poster = "Poster"; if (poster == "x") {}</script>',
  "<script>box.innerHTML = '<img src=\"https://outside.invalid/a.png\">';</script>",
  '<script>document.body.innerHTML = `<img\nsrc="https://outside.invalid/x.png">`;</script>',
  "<script>box.innerHTML = '<video poster=\"assets/image-1\">';</script>",
  "<script>box.innerHTML = '<button data-src=\"x\"><img src=\"assets/image-1\"></button>';</script>",
  "<script>const note = \"Make a poster= nice\";</script>",
  "<button onclick=\"this.innerHTML='<img src=https://outside.invalid>'\">Go</button>",
  '<template><img alt="" src="https://outside.invalid/a.png"></template>',
  '<template><img alt="" data-src="https://outside.invalid/a.png"></template>',
  '<template><video poster="assets/image-1"></video></template>',
  '<template><script>caches.keys()</script></template>',
  "<p>A plant cell caches energy.</p>",
  '<script>caches.open("x")</script>',
  "<script>const store = caches;</script>",
  '<script>const note = "It caches food";</script>',
  '<button onclick="caches.keys()">Save</button>',
  '<script type="application/json">{"caches":1}</script>',
  '<script>localStorage.setItem("a", "b")</script>',
  "<script>navigator.serviceWorker</script>",
  '<script type="module">import confetti from "https://outside.invalid/c.js";</script>',
];

test("the eval's HTML check accepts and rejects what production accepts and rejects", () => {
  for (const snippet of snippets) {
    const html = validHtml.replace("</body>", `${snippet}</body>`);
    let production = true;
    try {
      validateHtmlOutput({ html });
    } catch {
      production = false;
    }
    assert.equal(assessArtifact({ html }).valid, production, snippet);
  }
});
