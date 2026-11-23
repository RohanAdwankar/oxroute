// Scale absolute font sizes once, retaining inherited relative typography.
module.exports = () => ({postcssPlugin:'text-scale',OnceExit(root){
  root.walkDecls('font-size',declaration=>{
    const value=declaration.value;
    if(value.includes('--text-scale')||value.endsWith('%')||(value.endsWith('em')&&!value.endsWith('rem'))||['inherit','initial','unset','revert','revert-layer','smaller','larger'].includes(value))return;
    declaration.value=`calc(${value} * var(--text-scale, 1))`;
  });
}});
module.exports.postcss=true;
