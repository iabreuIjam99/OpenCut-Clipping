import { Loading03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "#/lib/utils.ts"

function Spinner({ className, strokeWidth = 2, ...props }: React.ComponentProps<"svg">) {
  const numericStrokeWidth =
    typeof strokeWidth === "number" ? strokeWidth : Number.parseFloat(strokeWidth)

  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={Number.isFinite(numericStrokeWidth) ? numericStrokeWidth : undefined}
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
