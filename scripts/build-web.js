import {build} from 'esbuild';
import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
mkdirSync('site/assets',{recursive:true});
await build({entryPoints:{app:'src/web/app.js'},bundle:true,splitting:true,format:'esm',platform:'browser',outdir:'site/assets',target:'es2022',minify:true,sourcemap:false,logLevel:'info'});
copyFileSync('src/web/index.html','site/index.html');copyFileSync('src/web/style.css','site/style.css');copyFileSync('assets/branding/icon.png','site/icon.png');writeFileSync('site/.nojekyll','');
