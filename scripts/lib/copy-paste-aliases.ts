/**
 * Flag `{name}2` / `{name}3` locals that rebind an existing `{name}` in scope
 * to the same identifier or the same property/element access.
 *
 * That is the leftover `const description2 = body.description as string | undefined`
 * pattern: unused-variable lint cannot see it because the alias is used.
 *
 * Independent re-fetches (`const pulled2 = await pull(...)`) are allowed even when
 * the call text matches, because the call is the point.
 */

import ts from 'typescript';

export interface CopyPasteAlias {
  fileName: string;
  line: number;
  alias: string;
  original: string;
}

const NUMBERED_ALIAS = /^([A-Za-z_][A-Za-z0-9_]*)[2-9]$/;

export function findCopyPasteAliases(sourceText: string, fileName: string): CopyPasteAlias[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const findings: CopyPasteAlias[] = [];
  const scopes: Array<Map<string, string>> = [new Map()];

  function lookup(name: string): string | undefined {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const core = scopes[i]?.get(name);

      if (core != null) {
        return core;
      }
    }

    return undefined;
  }

  function currentScope(): Map<string, string> {
    const scope = scopes[scopes.length - 1];

    if (!scope) {
      throw new Error('copy-paste alias walker lost its root scope');
    }

    return scope;
  }

  function coreText(expr: ts.Expression): string {
    return normalize(unwrap(expr).getText(sourceFile));
  }

  function recordBindingName(name: ts.BindingName, scope: Map<string, string>): void {
    if (ts.isIdentifier(name)) {
      scope.set(name.text, name.text);

      return;
    }

    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          recordBindingName(element.name, scope);
        }
      }
    }
  }

  function enterScope(node: ts.Node): boolean {
    if (ts.isSourceFile(node)) {
      return false;
    }

    if (ts.isFunctionLike(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      const scope = new Map<string, string>();

      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          recordBindingName(parameter.name, scope);
        }
      }

      scopes.push(scope);

      return true;
    }

    return false;
  }

  function visit(node: ts.Node): void {
    const pushed = enterScope(node);

    if (ts.isVariableDeclaration(node)) {
      const scope = currentScope();

      if (ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        const original = NUMBERED_ALIAS.exec(name)?.[1];
        const initializer = node.initializer;
        const core = coreText(initializer);

        if (original != null && isCopyPasteAlias(original, lookup(original), initializer, core)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));

          findings.push({
            fileName,
            line: line + 1,
            alias: name,
            original,
          });
        }

        scope.set(name, core);
      } else {
        recordBindingName(node.name, scope);
      }
    }

    ts.forEachChild(node, visit);

    if (pushed) {
      scopes.pop();
    }
  }

  visit(sourceFile);

  return findings;
}

function isCopyPasteAlias(
  original: string,
  originalCore: string | undefined,
  initializer: ts.Expression,
  core: string
): boolean {
  if (originalCore == null) {
    return false;
  }

  const inner = unwrap(initializer);

  if (ts.isIdentifier(inner) && inner.text === original) {
    return true;
  }

  return isCopyish(inner) && core === originalCore;
}

function isCopyish(expr: ts.Expression): boolean {
  return (
    ts.isIdentifier(expr) ||
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr)
  );
}

function unwrap(expr: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    return unwrap(expr.expression);
  }

  return expr;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
