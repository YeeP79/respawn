import nxPlugin from '@nx/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    plugins: {
      '@nx': nxPlugin,
    },
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
            {
              sourceTag: 'lang:ts',
              onlyDependOnLibsWithTags: ['lang:ts'],
            },
            {
              sourceTag: 'lang:python',
              onlyDependOnLibsWithTags: ['lang:python'],
            },
          ],
        },
      ],
    },
  },
);
