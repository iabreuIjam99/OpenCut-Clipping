import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { TooltipProvider } from "../components/ui/tooltip"

import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "OpenCut rewrite | beta.opencut.app",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/favicon.ico",
        type: "image/x-icon",
      },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&display=swap",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <DevTools />
        <Scripts />
      </body>
    </html>
  )
}

/**
 * TanStack DevTools solo en desarrollo.
 *
 * El import es dinámico y ocurre dentro de un efecto de montaje para que el
 * chunk de `@tanstack/react-devtools` / `@tanstack/react-router-devtools` no
 * entre en el grafo de producción (R4). En SSR y en el primer render del
 * cliente devuelve `null`, por lo que no hay desajuste de hidratación.
 */
function DevTools(): ReactNode {
  const [panel, setPanel] = useState<ReactNode>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    import("@tanstack/react-devtools").then((devtools) =>
      import("@tanstack/react-router-devtools").then((routerDevtools) => {
        setPanel(
          <devtools.TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <routerDevtools.TanStackRouterDevtoolsPanel />,
              },
            ]}
          />,
        )
      }),
    )
  }, [])

  return panel ?? null
}
