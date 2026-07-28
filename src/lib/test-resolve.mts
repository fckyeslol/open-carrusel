/**
 * Hook de resolución de módulos para los tests que corren con `node --test`.
 *
 * El código de la app usa dos cosas que TypeScript resuelve y Node no: el alias `@/…` del
 * tsconfig y los imports relativos SIN extensión (`./data`, `./telemetry`). Sin este hook,
 * cualquier test que cargue un módulo que a su vez importe así muere con
 * ERR_MODULE_NOT_FOUND — y el síntoma engaña, porque el runner reporta el archivo de test
 * entero como fallido en la línea 1:1, como si fuera un error de sintaxis.
 *
 * CÓMO USARLO: importalo ANTES de cargar el módulo bajo prueba, y cargá ese módulo con
 * `await import()`, no con un import estático (los estáticos se hoistean y correrían antes
 * que el hook):
 *
 *     import "./test-resolve.mts";
 *     const { loQueSea } = await import("./modulo.ts");
 *
 * La lógica es la misma que carousels.test.mts tiene inline; se extrajo acá al aparecer el
 * segundo test que la necesitaba. Ese archivo puede pasar a importar este helper y borrar
 * su copia cuando convenga.
 */
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `module.registerHooks` existe en Node 24 pero todavía no está en la versión de
 * @types/node del proyecto, así que se tipa acá en el borde en vez de arrastrar una
 * actualización de tipos por un test.
 */
type NextResolve = (specifier: string, context: unknown) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }) => void;
};

const SRC_DIR = path.resolve(import.meta.dirname, "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = path.join(SRC_DIR, `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
    if (specifier.startsWith(".") && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
