// VAPID anahtarlarını üretir: gizli anahtar .dev.vars'a, açık anahtar wrangler.jsonc'ye yazılır.
// Anahtarlar zaten varsa dokunmaz (değişirse mevcut abonelikler çalışmaz).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
if (devVars.includes("VAPID_PRIVATE_KEY=")) {
  console.log(".dev.vars içinde VAPID anahtarı zaten var, değiştirilmedi.");
  process.exit(0);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicRaw = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");

writeFileSync(".dev.vars", `${devVars}VAPID_PRIVATE_KEY='${JSON.stringify(privateJwk)}'\n`);

const wrangler = readFileSync("wrangler.jsonc", "utf8");
writeFileSync("wrangler.jsonc", wrangler.replace(/"VAPID_PUBLIC_KEY": "[^"]*"/, `"VAPID_PUBLIC_KEY": "${publicRaw}"`));

console.log("VAPID anahtarları oluşturuldu.");
console.log("Açık anahtar:", publicRaw);
