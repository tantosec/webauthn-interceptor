/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./public/**/*.html', './src/**/*.ts'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['system-ui', 'sans-serif'],
                mono: ['ui-monospace', 'monospace'],
            },
        },
    },
    plugins: [],
};
