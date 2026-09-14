// Custom ESLint rule enforcing R-L5 (Functional Design §1.5 / Technical
// Design §11): "No runtime concatenation. One parameterised string per
// sentence." — because word order differs by language, a sentence built by
// gluing t()-translated fragments together with "+" or a template literal
// cannot be correctly reordered by a translator working from messages.json
// alone.
//
// What this rule catches:
//   1. A `+` binary expression where at least one operand — anywhere in a
//      left-associative chain of "+" — is a call to a function named `t`,
//      e.g.:
//        t('a') + t('b')
//        t('greeting') + name
//        t('a') + ' ' + t('b')
//   2. A template literal with a `t(...)` call in one of its `${...}` slots,
//      e.g.:
//        `${t('greeting')}, ${name}!`
//
// What this rule deliberately does NOT catch (a scoped, pragmatic lint, not
// a full data-flow analysis — documented here and in docs/task-notes/T08.md):
//   - Concatenation through an intermediate variable:
//       const greeting = t('greeting')
//       const message = greeting + name
//   - `String.prototype.concat`, `Array.prototype.join`, or any other
//     concatenation API besides "+" and template literals.
//   - A template literal with only ONE t() call and no other dynamic
//     content — that's just interpolating a translated string into markup,
//     not composing a sentence from fragments — but the rule currently
//     flags it too, because distinguishing "one t() plus static text" from
//     "one t() plus another dynamic fragment" would need type information
//     this rule doesn't have. False positives here are treated as
//     acceptable given the alternative (missing real violations) is worse.
//   - A call to a translation helper under any name other than `t` (for
//     example if a component locally renames the import).
//   - Concatenation inside a Vue `<template>` block's mustache/directive
//     expressions — vue-eslint-parser exposes those as ordinary ESTree
//     nodes to rules, so this rule likely also fires there, but that path
//     was not exercised/verified during T08; treat template-expression
//     coverage as unconfirmed.

/**
 * @param {import('estree').Node} node
 */
function isTranslationCall(node) {
  return (
    !!node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 't'
  )
}

/**
 * True if `node` is, or (through a chain of "+" BinaryExpressions) contains,
 * a call to `t(...)`.
 * @param {import('estree').Node} node
 */
function containsTranslationCall(node) {
  if (!node) return false
  if (isTranslationCall(node)) return true
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return containsTranslationCall(node.left) || containsTranslationCall(node.right)
  }
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
const noTranslatedStringConcat = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow concatenating t(...) translation results with "+" or inside a template literal (R-L5).',
    },
    schema: [],
    messages: {
      concatPlus:
        'Do not concatenate a t(...) translation result with "+". Use a single parameterised message key instead (R-L5) — add a {placeholder} to the message in messages.json rather than assembling the sentence at the call site.',
      concatTemplate:
        'Do not embed t(...) in a template literal. Use a single parameterised message key instead (R-L5) — add a {placeholder} to the message in messages.json rather than assembling the sentence at the call site.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== '+') return
        // Only evaluate at the top of a "+" chain, so a three-way
        // concatenation (a + b + c) is reported once, not once per nested
        // BinaryExpression node.
        const parent = node.parent
        if (parent && parent.type === 'BinaryExpression' && parent.operator === '+') {
          return
        }
        if (containsTranslationCall(node)) {
          context.report({ node, messageId: 'concatPlus' })
        }
      },
      TemplateLiteral(node) {
        if (node.expressions.some((expr) => isTranslationCall(expr))) {
          context.report({ node, messageId: 'concatTemplate' })
        }
      },
    }
  },
}

export default noTranslatedStringConcat
