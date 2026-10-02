const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (_env, argv) => ({
    mode: argv.mode || 'development',
    devtool: argv.mode === 'production' ? false : 'cheap-module-source-map',
    entry: {
        background: './src/background.ts',
        content_injector: './src/content_injector.ts',
        webauthn_interceptor_main_world_script: './src/webauthn_interceptor_main_world_script.ts',
        'ui/interceptor-modal': './src/ui/interceptor-modal.ts',
        'ui/credential-selector': './src/ui/credential-selector.ts',
        popup: './public/popup/popup.ts',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        publicPath: '',
        clean: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'tsconfig.json'),
                            transpileOnly: false,
                            compilerOptions: {
                                noEmit: false,
                            },
                        },
                    },
                ],
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'LICENSE', to: '.' },
                { from: 'THIRD-PARTY-NOTICES.md', to: '.' },
                {
                    from: 'public',
                    to: '.',
                    globOptions: {
                        ignore: ['**/*.ts', '**/tailwind-input.css'],
                    },
                },
            ],
        }),
    ],
});
