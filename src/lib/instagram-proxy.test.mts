/**
 * Tests del pool de proxies residenciales de Instagram y su fallback.
 *
 *     npm test
 *
 * Lo que se protege acá es que NINGÚN proveedor sea punto único de falla. El
 * 2026-07-28 Litport empezó a devolver `500 / X-Proxy-Error-Code: 2` a todo CONNECT;
 * Chrome lo reporta como ERR_TUNNEL_CONNECTION_FAILED y la ingesta entera moría —
 * incluso en máquinas con IP residencial, donde la IP directa habría alcanzado sola.
 * Además la UI culpaba al post ("verificá que el post sea público"), que era falso.
 *
 * Se testea `withProxyFallback` (la política de reintento) y `ig-proxies` (el pool)
 * en vez de `downloadInstagramReference`, así no hace falta levantar Chrome ni salir
 * a la red.
 */
import assert from "node:assert/strict";
import nodeModule from "node:module";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

interface ResolveContext {
  parentURL?: string;
}
type NextResolve = (specifier: string, context: unknown) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: ResolveContext, next: NextResolve) => unknown;
  }) => void;
};

const SRC_DIR = path.resolve(import.meta.dirname, "..");
const SRC_URL = pathToFileURL(SRC_DIR).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = path.join(SRC_DIR, `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
    // El `.ts` implícito SOLO aplica a nuestro código. Sin el chequeo de parentURL el
    // hook también reescribía los imports internos de node_modules (instagram.ts
    // arrastra puppeteer, y semver hacía `require("./internal/re")` → buscaba re.ts).
    const fromOurSrc = context.parentURL?.startsWith(SRC_URL) ?? false;
    if (fromOurSrc && specifier.startsWith(".") && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { withProxyFallback, ProxyUnavailableError } = await import("./instagram.ts");
const igProxies = await import("./ig-proxies.ts");
const {
  getInstagramProxies,
  parseProxy,
  proxyTryOrder,
  markProxyDown,
  proxyPoolStats,
  __resetProxyCooldownForTests,
} = igProxies;

/** Un proxy de mentira, con la forma que devuelve parseProxy. */
const fakeProxy = (label: string) => ({
  server: "http://hub-us-11.litport.net:1337",
  username: "u",
  password: "p",
  label,
});

/** El error tal cual lo tira Puppeteer cuando el proxy no abre el túnel. */
const tunnelError = () =>
  new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://www.instagram.com/p/Da8AOtsFjam/");

const IG_ENV = ["IG_PROXY", "IG_PROXY_1", "IG_PROXY_2", "IG_PROXY_3", "IG_PROXY_COOLDOWN_MIN"];

beforeEach(() => {
  for (const k of IG_ENV) delete process.env[k];
  __resetProxyCooldownForTests();
});

describe("withProxyFallback", () => {
  it("corre una sola vez sin proxy cuando el pool está vacío", async () => {
    const calls: Array<string | undefined> = [];

    const result = await withProxyFallback([], async (p) => {
      calls.push(p?.label);
      return "ok";
    });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [undefined]);
  });

  it("usa el primer proxy y no sigue rotando cuando funciona", async () => {
    const calls: Array<string | undefined> = [];

    const result = await withProxyFallback([fakeProxy("a"), fakeProxy("b")], async (p) => {
      calls.push(p?.label);
      return "ok";
    });

    assert.equal(result, "ok");
    assert.deepEqual(calls, ["a"]);
  });

  it("rota al proxy siguiente cuando el primero no abre el túnel", async () => {
    const calls: Array<string | undefined> = [];

    const result = await withProxyFallback([fakeProxy("caido"), fakeProxy("bueno")], async (p) => {
      calls.push(p?.label);
      if (p?.label === "caido") throw tunnelError();
      return "ok por el segundo";
    });

    assert.equal(result, "ok por el segundo");
    assert.deepEqual(calls, ["caido", "bueno"]);
  });

  it("cae a la IP directa cuando TODOS los proxies fallan", async () => {
    const calls: Array<string | undefined> = [];

    const result = await withProxyFallback(
      [fakeProxy("a"), fakeProxy("b"), fakeProxy("c")],
      async (p) => {
        calls.push(p?.label);
        if (p) throw tunnelError();
        return "rescatado sin proxy";
      }
    );

    assert.equal(result, "rescatado sin proxy");
    assert.deepEqual(calls, ["a", "b", "c", undefined]);
  });

  it("marca en cooldown solo los proxies que fallaron", async () => {
    process.env.IG_PROXY = "http://u1:p@hub-us-11.litport.net:1337";
    process.env.IG_PROXY_2 = "http://u2:p@hub-us-12.litport.net:1337";
    const [first, second] = getInstagramProxies();

    await withProxyFallback([first, second], async (p) => {
      if (p?.label === first.label) throw tunnelError();
      return "ok";
    });

    const stats = proxyPoolStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.available, 1);
    assert.deepEqual(
      stats.coolingDown.map((c) => c.label),
      [first.label]
    );
  });

  it("clasifica como fallo de proxy todos los códigos de red de Chrome", async () => {
    const codes = [
      "ERR_TUNNEL_CONNECTION_FAILED",
      "ERR_PROXY_CONNECTION_FAILED",
      "ERR_PROXY_AUTH_REQUESTED",
      "ERR_PROXY_AUTH_UNSUPPORTED",
      "ERR_PROXY_CERTIFICATE_INVALID",
      "ERR_NO_SUPPORTED_PROXIES",
      "ERR_SOCKS_CONNECTION_FAILED",
      "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
    ];

    for (const code of codes) {
      let attempts = 0;
      const result = await withProxyFallback([fakeProxy(`p-${code}`)], async (p) => {
        attempts++;
        if (p) throw new Error(`net::${code} at https://www.instagram.com/`);
        return "rescatado";
      });
      assert.equal(result, "rescatado", `${code} debería disparar el fallback`);
      assert.equal(attempts, 2, `${code} debería intentar proxy y después directo`);
    }
  });

  it("envuelve en ProxyUnavailableError cuando los proxies Y la IP directa fallan", async () => {
    const directError = new Error(
      "Instagram no devolvió el carrusel completo desde el servidor: solo se pudo leer 1 imagen (la portada)."
    );

    await assert.rejects(
      withProxyFallback([fakeProxy("uno"), fakeProxy("dos")], async (p) => {
        if (p) throw tunnelError();
        throw directError;
      }),
      (err: unknown) => {
        assert.ok(err instanceof ProxyUnavailableError);
        assert.deepEqual(err.failedProxies, ["uno", "dos"]);
        // El mensaje tiene que cargar TODAS las causas: sin las de los proxies no se
        // sabe que hay que ir al proveedor, y sin la directa no se sabe qué pasó al
        // intentar sin ellos.
        assert.match(err.message, /ERR_TUNNEL_CONNECTION_FAILED/);
        assert.match(err.message, /solo se pudo leer 1 imagen/);
        assert.match(err.message, /Ninguno de los 2 proxies/);
        assert.equal(err.directError, directError);
        return true;
      }
    );
  });

  it("propaga el error directo tal cual cuando no había proxies configurados", async () => {
    // Sin proxies no hay nada que culpar: envolverlo en ProxyUnavailableError diría
    // que el proxy está caído cuando no hay ninguno.
    const postError = new Error("No se pudieron extraer imágenes del post");

    await assert.rejects(
      withProxyFallback([], async () => {
        throw postError;
      }),
      (err: unknown) => {
        assert.equal(err, postError);
        assert.ok(!(err instanceof ProxyUnavailableError));
        return true;
      }
    );
  });

  it("NO rota ni reintenta cuando el error no es del proxy", async () => {
    // Un post privado/borrado falla igual con cualquier proxy: rotar solo multiplicaría
    // la espera para dar el mismo error, y con la descarga a medias duplicaría archivos.
    const postError = new Error(
      "No se pudieron extraer imágenes del post (¿privado, borrado, o Instagram pide login?)."
    );
    let attempts = 0;

    await assert.rejects(
      withProxyFallback([fakeProxy("a"), fakeProxy("b")], async () => {
        attempts++;
        throw postError;
      }),
      (err: unknown) => {
        // Se propaga TAL CUAL: no se disfraza de problema de proxy.
        assert.equal(err, postError);
        assert.ok(!(err instanceof ProxyUnavailableError));
        return true;
      }
    );
    assert.equal(attempts, 1, "no debería tocar el segundo proxy");
  });
});

describe("pool de proxies (ig-proxies)", () => {
  it("no devuelve nada cuando no hay ninguno configurado", () => {
    assert.deepEqual(getInstagramProxies(), []);
  });

  it("separa credenciales del server (Chrome no las acepta en --proxy-server)", () => {
    const p = parseProxy("http://usuario:cla%40ve@hub-us-11.litport.net:1337");
    assert.equal(p?.server, "http://hub-us-11.litport.net:1337");
    assert.equal(p?.username, "usuario");
    assert.equal(p?.password, "cla@ve"); // percent-decodificada
    // La etiqueta para logs NO puede filtrar las credenciales.
    assert.ok(!p!.label.includes("usuario"));
    assert.ok(!p!.label.includes("cla@ve"));
  });

  it("devuelve null en una URL inválida (degrada a sin proxy, no revienta)", () => {
    assert.equal(parseProxy("no-es-una-url"), null);
    assert.equal(parseProxy(""), null);
  });

  it("junta IG_PROXY y los numerados, en orden", () => {
    process.env.IG_PROXY = "http://u0:p@host0:1337";
    process.env.IG_PROXY_1 = "http://u1:p@host1:1337";
    process.env.IG_PROXY_3 = "http://u3:p@host3:1337";

    const servers = getInstagramProxies().map((p) => p.server);
    assert.deepEqual(servers, [
      "http://host0:1337",
      "http://host1:1337",
      "http://host3:1337",
    ]);
  });

  it("acepta varios proxies en una sola variable", () => {
    process.env.IG_PROXY = "http://u1:p@host1:1337, http://u2:p@host2:1337";
    assert.equal(getInstagramProxies().length, 2);
  });

  it("distingue dos usuarios sobre el MISMO host:puerto", () => {
    // Caso real: `prewave` y `prewavefallback` en hub-us-11.litport.net:1337. Si la
    // etiqueta fuera solo host:puerto, el cooldown de uno taparía al otro.
    process.env.IG_PROXY = "http://prewave:a@hub-us-11.litport.net:1337";
    process.env.IG_PROXY_2 = "http://prewavefallback:b@hub-us-11.litport.net:1337";

    const proxies = getInstagramProxies();
    assert.equal(proxies.length, 2);
    assert.notEqual(proxies[0].label, proxies[1].label);
  });

  it("de-duplica el mismo proxy repetido", () => {
    process.env.IG_PROXY = "http://u:p@host:1337";
    process.env.IG_PROXY_2 = "http://u:p@host:1337";
    assert.equal(getInstagramProxies().length, 1);
  });

  it("saltea los que están en cooldown", () => {
    process.env.IG_PROXY = "http://u1:p@host1:1337";
    process.env.IG_PROXY_2 = "http://u2:p@host2:1337";
    const [first] = getInstagramProxies();

    markProxyDown(first, "500");

    assert.deepEqual(
      proxyTryOrder().map((p) => p.server),
      ["http://host2:1337"]
    );
  });

  it("si TODOS están en cooldown intenta uno solo, el que resetea antes", () => {
    process.env.IG_PROXY = "http://u1:p@host1:1337";
    process.env.IG_PROXY_2 = "http://u2:p@host2:1337";
    const [first, second] = getInstagramProxies();

    // `second` cae después, así que su cooldown vence más tarde.
    markProxyDown(first, "500");
    markProxyDown(second, "500");

    const order = proxyTryOrder();
    assert.equal(order.length, 1, "no tiene sentido pagar N túneles muertos");
    assert.equal(order[0].label, first.label);
  });

  it("respeta IG_PROXY_COOLDOWN_MIN", () => {
    process.env.IG_PROXY = "http://u:p@host:1337";
    process.env.IG_PROXY_COOLDOWN_MIN = "1";
    const [only] = getInstagramProxies();

    markProxyDown(only, "500");
    const [entry] = proxyPoolStats().coolingDown;
    const minutesOut = (new Date(entry.until).getTime() - Date.now()) / 60000;

    assert.ok(minutesOut > 0 && minutesOut <= 1.1, `esperaba ~1 min, dio ${minutesOut}`);
  });
});
