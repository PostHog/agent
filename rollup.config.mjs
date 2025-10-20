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

export default defineConfig([
  // ESM build
  {
    input: 'index.ts',
    output: {
      file: 'dist/index.mjs',
      format: 'esm',
      sourcemap: true,
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
          }
        ],
        hook: 'writeBundle'
      })
    ]
  },
  // CJS build
  {
    input: 'index.ts',
    output: {
      file: 'dist/index.cjs',
      format: 'cjs',
      sourcemap: true,
      exports: 'named',
    },
    external,
    plugins: [
      nodeResolve({
        extensions: ['.ts', '.js', '.json']
      }),
      commonjs(),
      typescript({
        tsconfig: path.resolve('tsconfig.rollup.json'),
        tsconfigOverride: {
          compilerOptions: {
            skipLibCheck: true
          }
        }
      })
    ]
  }
]);
