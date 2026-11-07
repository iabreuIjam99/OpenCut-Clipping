import { createFileRoute } from "@tanstack/react-router"
import { ClientOnly } from "../components/client-only"

export const Route = createFileRoute("/editor")({ component: Editor })

function Editor() {
  return (
    <ClientOnly>
      <main>
        <h1>Editor</h1>
        <p>Coming soon.</p>
      </main>
    </ClientOnly>
  )
}
