import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.{ts,tsx}"],
      // UI kit preexistente y rutas cubrense en sus propias tasks (5, 19).
      exclude: ["src/components/ui/**", "src/routes/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        perFile: false,
      },
    },
  },
})
