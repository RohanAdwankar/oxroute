const parse = require('postcss-value-parser');
const dimensions = new Set(['width','min-width','max-width','height','min-height','max-height','top','right','bottom','left','gap','row-gap','column-gap','flex-basis','line-height','outline-offset','border-spacing','--spacing','--cell','--pane-x','--row-y']);
// Typography retains the full reading range; layout and controls shrink together below 100%.
module.exports = () => ({postcssPlugin:'text-scale',OnceExit(root){
  root.walkDecls(declaration=>{
    const value=declaration.value;
    if(declaration.prop==='font-size'){
      if(value.includes('--text-scale')||value.endsWith('%')||(value.endsWith('em')&&!value.endsWith('rem'))||['inherit','initial','unset','revert','revert-layer','smaller','larger'].includes(value))return;
      declaration.value=`calc(${value} * var(--text-scale, 1))`;return;
    }
    if(value.includes('--ui-scale')||!(dimensions.has(declaration.prop)||['padding','margin','border','inset'].some(property=>declaration.prop===property||declaration.prop.startsWith(property+'-'))))return;
    const parsed=parse(value);
    parsed.walk(node=>{
      if(node.type==='function'&&node.value==='url')return false;
      if(node.type!=='word')return;
      const length=parse.unit(node.value);
      if(length&&['px','rem'].includes(length.unit))node.value=`calc(${node.value} * var(--ui-scale, 1))`;
    });
    declaration.value=parsed.toString();
  });
}});
module.exports.postcss=true;
