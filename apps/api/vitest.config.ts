import { defineConfig } from "vitest/config"

// src/index.ts es el bootstrap de Elysia (3 rutas + .compile()); se excluye del gate de cobertura.
export default defineConfig({
  test: {
    environment: "node",
    // Sin modulos de feature todavia: src solo contiene el bootstrap excluido (src/index.ts).
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
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
