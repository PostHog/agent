import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import copy from 'rollup-plugin-copy';
import typescript from 'rollup-plugin-typescript2';
import { builtinModules } from 'module';
import path from 'path';

const external = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  '@anthropic-ai/claude-agent-sdk',
  'dotenv',
  'openai',
  'zod'
];

export default defineConfig({
  input: 'index.ts',
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: true,
    preserveModules: true,
    preserveModulesRoot: '.',
    entryFileNames: '[name].js',
    chunkFileNames: '[name].js'
  },
  external,
  plugins: [
    nodeResolve({
      extensions: ['.ts', '.js', '.json']
    }),
    commonjs(),
    typescript({
      tsconfig: path.resolve('tsconfig.rollup.json'),
      useTsconfigDeclarationDir: true,
      clean: true,
      tsconfigOverride: {
        compilerOptions: {
          skipLibCheck: true
        }
      }
    }),
    copy({
      targets: [
        {
          src: 'src/templates/*',
          dest: 'dist/templates'
        },
        // Bundle Claude CLI so consumers don't need to navigate nested node_modules
        {
          src: 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
          dest: 'dist/claude-cli'
        },
        // Create package.json for ES module support
        {
          src: 'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
          dest: 'dist/claude-cli',
          transform: (contents) => {
            // Only keep "type": "module" from the original package.json
            return JSON.stringify({ type: 'module' }, null, 2);
          }
        },
        // Copy yoga.wasm file that Claude CLI needs
        {
          src: 'node_modules/yoga-wasm-web/dist/yoga.wasm',
          dest: 'dist/claude-cli'
        }
      ],
      hook: 'writeBundle'
    })
  ]
});
