import {build} from 'esbuild';
import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
mkdirSync('site/assets',{recursive:true});
await build({entryPoints:{app:'src/web/app.js'},bundle:true,splitting:true,format:'esm',platform:'browser',outdir:'site/assets',target:'es2022',minify:true,sourcemap:false,logLevel:'info'});
const revision=process.env.GITHUB_SHA??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),repository=process.env.GITHUB_REPOSITORY??'amosroger91/LLMesh';
if(!/^[a-f0-9]{40}$/.test(revision)||!/^[-\w]+\/[-.\w]+$/.test(repository))throw new Error('Invalid repository asset revision');
await build({entryPoints:['src/web/asset-worker.js'],bundle:true,format:'iife',platform:'browser',outfile:'site/asset-worker.js',target:'es2022',minify:true,define:{__ASSET_BASE__:JSON.stringify('https://raw.githubusercontent.com/'+repository+'/'+revision+'/vendor/browser/')}});
copyFileSync('src/web/index.html','site/index.html');copyFileSync('src/web/style.css','site/style.css');copyFileSync('assets/branding/icon.png','site/icon.png');writeFileSync('site/.nojekyll','');
