// One-off: add Tip 4 (Pídele opciones) + Tip 5 (Dale un rol) to the Claude-tips
// carousel and de-number the CTA. Mirrors the live inline-style slide format.
const fs = require("fs");
const crypto = require("crypto");

const FILE = "data/carousels.json";
const CAROUSEL_ID = "371978c4-557d-4954-bf7b-a43b9ad356c6";
const ORANGE =
  "filter:invert(44%) sepia(74%) saturate(800%) hue-rotate(347deg) brightness(95%) contrast(95%);";
const FONT =
  "<style>\n  @import url('https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,600;0,700;0,900;1,900&display=swap');\n  * { margin:0; padding:0; box-sizing:border-box; }\n</style>";

function tipSlide({ num, title, sub, heroIcon, cards, body, trigger, blobTop }) {
  const blobs = blobTop
    ? '<div style="position:absolute;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(232,101,26,0.16) 0%,transparent 65%);top:-130px;right:-130px;"></div>\n  <div style="position:absolute;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(27,43,107,0.11) 0%,transparent 65%);bottom:-80px;left:-80px;"></div>'
    : '<div style="position:absolute;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(232,101,26,0.16) 0%,transparent 65%);bottom:-130px;right:-130px;"></div>\n  <div style="position:absolute;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(27,43,107,0.11) 0%,transparent 65%);top:-80px;left:-80px;"></div>';
  const cardHtml = cards
    .map(
      (t) =>
        '      <div style="display:flex;align-items:center;gap:20px;background:rgba(27,43,107,0.06);border-radius:14px;padding:18px 24px;border-left:5px solid #E8651A;">\n' +
        '        <img src="/uploads/icons/d846e5a5-6e6f-4956-ae2c-0418738f3680.svg" style="width:28px;height:28px;flex-shrink:0;' +
        ORANGE +
        '">\n' +
        '        <div style="font-size:24px;color:#1B2B6B;font-weight:700;line-height:1.3;">' +
        t +
        "</div>\n      </div>"
    )
    .join("\n");
  return (
    FONT +
    "\n<div style=\"width:1080px;height:1350px;background:#F5F0E8;font-family:'Nunito',sans-serif;position:relative;overflow:hidden;display:flex;flex-direction:column;padding:80px;\">\n\n  " +
    blobs +
    '\n\n  <div style="position:absolute;top:68px;right:80px;font-size:21px;color:#E8651A;font-weight:700;letter-spacing:1.5px;opacity:0.65;">@mateo.pirela</div>\n\n' +
    '  <div style="font-size:120px;color:#E8651A;font-weight:900;font-style:italic;line-height:1;margin-bottom:8px;">' +
    num +
    "</div>\n" +
    '  <div style="font-size:64px;color:#E8651A;font-weight:900;line-height:1.05;margin-bottom:4px;">' +
    title +
    "</div>\n" +
    '  <div style="font-size:58px;color:#1B1B1B;font-weight:900;line-height:1.05;margin-bottom:40px;">' +
    sub +
    "</div>\n\n" +
    '  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;margin-bottom:36px;">\n\n' +
    '    <img src="/uploads/icons/' +
    heroIcon +
    '"\n         style="width:168px;height:168px;' +
    ORANGE +
    '">\n\n' +
    '    <div style="display:flex;flex-direction:column;gap:16px;width:100%;">\n' +
    cardHtml +
    "\n    </div>\n  </div>\n\n" +
    '  <div style="font-size:25px;color:#1B2B6B;font-style:italic;font-weight:600;text-align:center;line-height:1.65;margin-bottom:28px;">\n    ' +
    body +
    "\n  </div>\n\n" +
    '  <div style="position:absolute;bottom:52px;right:80px;font-size:20px;color:#E8651A;font-weight:700;">' +
    trigger +
    "</div>\n</div>"
  );
}

const tip4 = tipSlide({
  num: "4",
  title: "P&#237;dele opciones",
  sub: "no una respuesta.",
  heroIcon: "753f0ce3-49e1-4caf-b67c-20395428dbea.svg", // speech_bubble
  cards: [
    '"Dame 3 versiones distintas."',
    '"Una directa, una c&#225;lida, una con humor."',
    '"Combina lo mejor de la 1 y la 3."',
  ],
  body:
    "No te cases con la primera.<br>Pide varias y qu&#233;date con lo mejor de cada una.",
  trigger: "&#8594; el rol lo cambia todo",
  blobTop: true,
});

const tip5 = tipSlide({
  num: "5",
  title: "Dale un rol",
  sub: "antes de preguntar.",
  heroIcon: "1877763e-2839-49cf-94b7-e5d1ba5eb00d.svg", // person_read
  cards: [
    '"Act&#250;a como editor exigente."',
    '"Eres un inversor esc&#233;ptico."',
    '"Expl&#237;camelo como si tuviera 12."',
  ],
  body:
    "El mismo prompt, con un rol distinto,<br>te da una respuesta de otro nivel.",
  trigger: "&#8594; lo m&#225;s importante, al final",
  blobTop: false,
});

const mk = (html, notes) => ({
  id: crypto.randomUUID(),
  html,
  previousVersions: [],
  order: 0,
  notes,
});

const c = JSON.parse(fs.readFileSync(FILE, "utf8"));
const live = c.carousels.find((x) => x.id === CAROUSEL_ID);
const slides = live.slides;
const cta = slides[slides.length - 1];

// Remove the standalone "5" number block from the CTA (tips now own 1-5).
cta.html = cta.html.replace(
  /\n\n  <div style="font-size:120px;color:#E8651A;font-weight:900;font-style:italic;line-height:1;align-self:flex-start;margin-bottom:16px;">5<\/div>/,
  ""
);
cta.notes = "Slide 7 — CTA: El que lo usa bien gana";

const rebuilt = [
  slides[0],
  slides[1],
  slides[2],
  slides[3],
  mk(tip4, "Slide 5 — Tip 4: Pídele opciones"),
  mk(tip5, "Slide 6 — Tip 5: Dale un rol"),
  cta,
];
rebuilt.forEach((s, i) => (s.order = i));
live.slides = rebuilt;

fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
console.log("Rebuilt carousel: " + rebuilt.length + " slides");
rebuilt.forEach((s, i) => console.log("  " + i + " | " + s.notes));
console.log(
  "CTA number block removed? ",
  !/align-self:flex-start;margin-bottom:16px;">5</.test(cta.html)
);
