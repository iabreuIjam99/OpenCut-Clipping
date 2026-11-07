import { type ReactNode, useEffect, useState } from "react"

/**
 * Componente reutilizable que renderiza `null` en el servidor y durante la
 * primera hidratación, montando `children` solo en el cliente tras `useEffect`.
 *
 * Reglas (R5):
 * - En SSR devuelve `null` (nunca un placeholder distinto) para evitar
 *   desajustes de hidratación.
 * - Nunca usa `typeof window` durante el render; el montaje se detecta con
 *   `useEffect`.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  return <>{children}</>
}
