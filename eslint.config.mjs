import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', 'node_modules/'] },
    ...tseslint.configs.recommended,
    {
        files: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
        rules: {
            'no-restricted-globals': [
                'error',
                'window',
                'document',
                'navigator',
                'self',
                'Worker',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'setImmediate',
                'clearImmediate',
                'MessageChannel',
                'postMessage',
                'addEventListener',
                'removeEventListener',
            ],
        },
    }
);
