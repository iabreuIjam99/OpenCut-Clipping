import { defineConfig } from "vitest/config"

// src/index.ts es el bootstrap de Elysia (3 rutas + .compile()); se excluye del gate de cobertura.
export default defineConfig({
  test: {
    environment: "node",
    // PROVISIONAL: no measurable api module exists until Task 13 (config/env.ts). Task 13 MUST remove this flag and make the gate real.
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
