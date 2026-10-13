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
  '<svg><linearGradient id="g"></linearGradient><rect fill="url(#g)" marker-end="url( \'#arrow\' )"/></svg>',
  '<svg><rect fill="url(https://outside.invalid/x.svg#g)"/></svg>',
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
  '<script type="module">import "https://outside.invalid/c.js";</script>',
  '<script type="module">export * from "https://outside.invalid/c.js";</script>',
  '<script type="module">export { a } from "https://outside.invalid/c.js";</script>',
  '<script type="module">import/**/("https://outside.invalid/c.js");</script>',
  '<script type="module">export const a = 1; export { a as b };</script>',
  '<p>Countries import "rice" and {beans}; we require (care).</p>',
  "<p>Countries import (and export) rice.</p>",
  '<p>A shop wants to import rice from Thailand.</p><label for="from">From</label><select id="from"></select>',
  '<p>We import</p><script type="text/template">import x from "https://outside.invalid/x.js"</script>',
  '<p>We import</p><script>const x = require("https://outside.invalid/x.js")</script>',
  // Lesson text calls nothing, but scripts, handlers and stored markup do.
  "<p>Fetch (get the instruction), decode, execute.</p><title>Import (n.)</title>",
  "<p>navigator.serviceWorker and new WebSocket(url)</p>",
  "<p>&lt;b onclick=\"fetch('x')\"&gt;</p>",
  "<textarea><b onclick=\"fetch('x')\">Go</b></textarea>",
  '<script type="text/template">fetch("https://outside.invalid/")</script>',
  "<script>const step = \"Fetch (get the instruction)\";</script>",
  "<button onclick=\"fetch('x')\">Go</button>",
  // Text a table moves before itself joins earlier text but not its markup.
  '<div>a<table><script>fetch("x")</script>b</table></div>',
  "<div>a<table><tr><td data-m='<video poster=x>'></td></tr>b</table></div>",
  // Script variables are exempt only where parsing finds a declaration or a
  // script assignment, not anywhere a name starts a line or follows punctuation.
  '<script>\r\nlet src;\r\nsrc = document.body.dataset.src;\r\nvoid src</script>',
  '<button onclick="const href = this.dataset.href; void href">Go</button>',
  // A dataset property names a data-* attribute, which loads nothing.
  "<script>const b = document.body; b.dataset.action = 'check'; b.dataset.src = `pool-${1}`; b.dataset.href = 'https://outside.invalid/';</script>",
  `<button onclick="this.dataset.action = 'reset'">Reset</button>`,
  '<script>document.body.dataset.src = "x"; document.images[0].src = "https://outside.invalid/x.png";</script>',
  '<script>const poster = 1; [poster].find((poster) => poster === 1);</script>',
  '<script>const u = "https://outside.invalid/x.png"; document.body.innerHTML = `<img\n  src="${u}" alt="">`;</script>',
  '<script>const u = "https://outside.invalid/x.png"; document.body.innerHTML = "<img \\\nsrc=" + u + ">";</script>',
  '<script>document.body.innerHTML = /<img let src="https:\\/\\/outside.invalid\\/x.png">/.source;</script>',
  `<img alt="" src="assets/image-1" onerror="0;src='https://outside.invalid/x.png'">`,
  '<script>with (document.images[0]) { var src = "https://outside.invalid/x.png" }</script>',
  // Parameters, destructuring defaults and class fields bind names too, but a
  // destructuring assignment in a handler can still set the element's URL.
  "<script>function handleAction(action = 'check') { return action; }</script>",
  "<script>const pick = (action = 'check') => action;</script>",
  "<script>const {src = 'placeholder'} = {};</script>",
  "<script>const { card: { href = 'none' }, list: [poster = 'blank', ...action] } = { card: {}, list: [] };</script>",
  "<script>let formaction; [formaction = 'next'] = []; ({ src = 'later' } = {});</script>",
  "<script>try { void 0 } catch ({ href = 'none' }) {}</script>",
  "<script>class Game { action = 'idle'; static src = 'none'; }</script>",
  `<button onclick="const go = (action = 'check') => action; const {href = 'none'} = {}; go()">Go</button>`,
  `<img alt="" src="assets/image-1" onerror="({src = 'https://outside.invalid/x.png'} = {})">`,
  `<img alt="" src="assets/image-1" onerror="const f = (a = src = 'https://outside.invalid/x.png') => a; f()">`,
  // An exempt name never hides a later one, nor does text before a real attribute.
  `<a onclick="var action = href = 'https://outside.invalid/'">Go</a>`,
  "<script>var action = href = 'https://outside.invalid/';</script>",
  '<p>href="#</p><a href=https://outside.invalid/>Go</a><p>"</p>',
  // srcset and poster anywhere outside script variables, such as stored markup.
  `<div data-markup='<img srcset="https://outside.invalid/x.png 2x">'></div>`,
  '<textarea><video poster="https://outside.invalid/x.png"></video></textarea>',
  "<p>1 poster = $3</p><textarea>Poster=2</textarea>",
  "<p>Pen = $1. Poster = $3.</p>",
  "<p>Newton's third law: Action = Reaction.</p><textarea>src = source</textarea>",
  '<p>Action = Reaction.</p><p>href="https://outside.invalid/"</p>',
  `<p>Pen = $1. Poster = $3.</p><video onclick="this. poster = 'https://outside.invalid/x.png'"></video>`,
  '<textarea>&lt;video poster="https://outside.invalid/x.png"&gt;</textarea>',
  '<script type="text/template"><img srcset="assets/image-1 1x"></script>',
  `<video onclick="0;poster='https://outside.invalid/x.png'"></video>`,
  // formaction is checked like action.
  '<form><button formaction="https://outside.invalid/">Send</button></form>',
  '<button data-formaction="check">Check</button>',
  '<script>const formaction = 1; let next = formaction;</script>',
  // Literal URLs passed to setAttribute and setAttributeNS.
  '<script>document.images[0].setAttribute("src", "https://outside.invalid/x.png")</script>',
  "<script>document.images[0].setAttribute('SRC', `https://outside.invalid/x.png`)</script>",
  `<button onclick="document.forms[0]?.setAttribute('action', 'https://outside.invalid/')">Go</button>`,
  '<button onclick="this.setAttribute(&quot;formaction&quot;, &quot;https://outside.invalid/&quot;)">Go</button>',
  '<script>document.links[0].setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "https://outside.invalid/")</script>',
  '<script>const image = document.images[0]; image.setAttribute("src", "assets/image-1"); image.setAttribute("href", `#top`); image.setAttribute("src", image.dataset.src); image.setAttribute("alt", "https://outside.invalid/");</script>',
  // A name inside a fragment link or another URL value loads nothing, but a
  // substitution or escape that could end the value does not hide a name.
  '<a href="#action=go">Go</a><a href=#src=x>X</a><div data-href="#/route?src=x&action=y"></div>',
  '<svg><use xlink:href="#action=go"></use></svg>',
  '<script type="text/template"><a href="#action=go">Go</a></script>',
  `<script>document.body.insertAdjacentHTML("beforeend", '<a href="#action=go">Go</a>');</script>`,
  "<script>const id = 1; document.body.innerHTML = `<a href=\"#/item?id=${id}&action=view\">View</a>`;</script>",
  `<script>const link = document.createElement("a"); link.href = "#action=go"; const href = '#src=x';</script>`,
  `<button onclick="location.href = '#action=go'">Go</button>`,
  '<a href=\'#top"><img src="https://outside.invalid/x.png">\'>Go</a>',
  `<script>document.body.innerHTML = '<img data-src="#\\x22 src=https://outside.invalid/x.png">';</script>`,
  "<script>const q = '\"'; document.body.innerHTML = `<img data-src=\"#${q} src=https://outside.invalid/x.png\">`;</script>",
  "<script>const q = '\"a='; document.body.innerHTML = `<img alt=\"${q}\" data-src=\"#x src=https://outside.invalid/x.png\">`;</script>",
  "<script>const link = document.createElement('a'); link.href = `#${document.images[0].src = 'https://outside.invalid/x.png'}`;</script>",
  '<script type="text/template"><a href="#top"><img src="https://outside.invalid/x.png"></a></script>',
  `<script>const href = "#x' src='https://outside.invalid/x.png"; document.body.innerHTML = "<img alt='" + href + "'>";</script>`,
  `<script>document.body.innerHTML = '<img alt="' + '<a href="#x src=https://outside.invalid/x.png">';</script>`,
  '<div data-href="#x&#32;src=https://outside.invalid/x.png"></div>',
  // External URLs that scripts write as template literals.
  "<script>const image = new Image(); image.src = `https://outside.invalid/${1}.png`;</script>",
  '<script>document.images[0].setAttribute("src", `https://outside.invalid/${1}.png`);</script>',
  '<img alt="" src="assets/image-1" onerror="src = `https://outside.invalid/${&quot;x&quot;}.png`">',
  "<script>document.images[0].src = `/\\\\outside.invalid/${1}.png`;</script>",
  "<script>document.images[0].src = `ht\\ttps://outside.invalid/${1}.png`;</script>",
  "<script>const id = 'image-1'; document.images[0].src = `assets/${id}`; document.links[0].href = `#${id}`;</script>",
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
