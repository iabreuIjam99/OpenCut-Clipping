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
        // Task 12 (R9): el Worker real importa @huggingface/transformers y solo
        // corre en un scope de Worker — jsdom no puede ejecutarlo, quedaría al
        // 0 % y arrastraría el umbral global sin aportar señal. Su protocolo y
        // orquestación sí se cubren vía transcribe-protocol/local.test.ts.
        "src/lib/media/transcribe.worker.ts",
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
