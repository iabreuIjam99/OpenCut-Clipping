import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.{ts,tsx}"],
      // UI kit preexistente y rutas cubrense en sus propias tasks (5, 19); los ficheros de test se excluyen.
      exclude: [
        "src/components/ui/**",
        "src/routes/**",
        "src/lib/**/*.test.ts",
        "src/lib/**/*.spec.ts",
      ],
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
