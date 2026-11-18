// Parsing external text must not throw through a render or event boundary.
const rule = {
  meta: {type: 'problem', schema: [], messages: {unguarded: 'Handle {{operation}} failures in this function with try/catch.'}},
  create(context) {
    function global(node, name) {
      if (node?.type !== 'Identifier' || node.name !== name) return false;
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const binding = scope.set.get(name);
        if (binding) return binding.defs.length === 0;
        scope = scope.upper;
      }
      return true;
    }
    function builtin(node, name) {
      return global(node, name) || node?.type === 'MemberExpression' && !node.computed &&
        (global(node.object, 'window') || global(node.object, 'globalThis')) && node.property.name === name;
    }
    function location(node) {
      if (global(node, 'location')) return true;
      return node?.type === 'MemberExpression' && !node.computed &&
        global(node.object, 'window') && node.property.name === 'location';
    }
    function trusted(node) {
      return node?.type === 'Literal' && typeof node.value === 'string' ||
        node?.type === 'MemberExpression' && !node.computed &&
        (location(node.object) && ['href', 'origin'].includes(node.property.name) ||
         node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.property.name === 'url');
    }
    function guarded(node) {
      for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(parent.type)) return false;
        if (parent.type === 'TryStatement' && parent.block === child && parent.handler) return true;
      }
      return false;
    }
    function check(node, operation) {
      if (guarded(node)) return;
      if (node.arguments.every(arg => trusted(arg) && (operation === 'URL' || arg.type === 'Literal'))) {
        try {
          const values = node.arguments.map(arg => arg.type === 'Literal' ? arg.value : 'https://example.invalid/');
          if (operation === 'URL') new URL(...values);
          else if (operation === 'decodeURI') decodeURI(values[0]);
          else decodeURIComponent(values[0]);
          return;
        } catch { /* Invalid literals need the same boundary as dynamic input. */ }
      }
      context.report({node, messageId: 'unguarded', data: {operation}});
    }
    return {
      NewExpression(node) {if (builtin(node.callee, 'URL')) check(node, 'URL');},
      CallExpression(node) {
        for (const name of ['decodeURI', 'decodeURIComponent']) if (builtin(node.callee, name)) check(node, name);
      },
    };
  },
};

export default rule;
