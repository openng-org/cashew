import { chain, Rule, SchematicContext, SchematicsException, Tree, UpdateRecorder } from '@angular-devkit/schematics';
import { addRootProvider, readWorkspace } from '@schematics/angular/utility';
import * as ts from 'typescript';
import { Schema } from './schema';

const CASHEW_PACKAGE = '@openng/cashew';
const HTTP_PACKAGE = '@angular/common/http';

const MANUAL_SETUP_SNIPPET = `
  import { provideHttpClient, withInterceptors } from '@angular/common/http';
  import { withHttpCacheInterceptor } from '@openng/cashew';

  providers: [
    provideHttpClient(withInterceptors([withHttpCacheInterceptor()]))
  ]
`;

export function ngAdd(options: Schema): Rule {
  return async (tree: Tree) => {
    const workspace = await readWorkspace(tree);

    let projectName = options.project;
    if (!projectName) {
      for (const [name, project] of workspace.projects) {
        if (project.extensions['projectType'] === 'application') {
          projectName = name;
          break;
        }
      }
    }

    const project = projectName ? workspace.projects.get(projectName) : undefined;
    if (!projectName || !project) {
      throw new SchematicsException(
        `Unable to find project "${
          options.project ?? ''
        }" in the workspace. Use the --project option to specify an application.`
      );
    }

    const sourceRoot = project.sourceRoot ?? `${project.root}/src`;

    return chain([setupInterceptor(projectName, sourceRoot), setupProvideHttpCache(projectName, sourceRoot)]);
  };
}

function setupInterceptor(projectName: string, sourceRoot: string): Rule {
  return (tree: Tree, context: SchematicContext) => {
    if (projectContains(tree, sourceRoot, 'withHttpCacheInterceptor')) {
      context.logger.info('The cashew interceptor is already registered. Skipping.');
      return;
    }

    const httpClientFile = findFileContaining(tree, sourceRoot, 'provideHttpClient(');
    if (httpClientFile) {
      return addInterceptorToExistingHttpClient(httpClientFile, context);
    }

    if (projectContains(tree, sourceRoot, 'HttpClientModule')) {
      context.logger.warn(
        `Your application uses the legacy HttpClientModule. Replace it with provideHttpClient and register the cashew interceptor manually:\n${MANUAL_SETUP_SNIPPET}`
      );
      return;
    }

    return addRootProvider(projectName, ({ code, external }) => {
      return code`${external('provideHttpClient', HTTP_PACKAGE)}(${external(
        'withInterceptors',
        HTTP_PACKAGE
      )}([${external('withHttpCacheInterceptor', CASHEW_PACKAGE)}()]))`;
    });
  };
}

function setupProvideHttpCache(projectName: string, sourceRoot: string): Rule {
  return (tree: Tree, context: SchematicContext) => {
    if (projectContains(tree, sourceRoot, 'provideHttpCache(')) {
      context.logger.info('provideHttpCache is already registered. Skipping.');
      return;
    }

    return addRootProvider(projectName, ({ code, external }) => {
      return code`${external('provideHttpCache', CASHEW_PACKAGE)}()`;
    });
  };
}

/**
 * Adds `withHttpCacheInterceptor()` to an existing `provideHttpClient(...)` call:
 * appended to the `withInterceptors([...])` array when present, otherwise as a new
 * `withInterceptors([...])` feature argument.
 */
function addInterceptorToExistingHttpClient(filePath: string, context: SchematicContext): Rule {
  return (tree: Tree) => {
    const content = tree.readText(filePath);
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const httpClientCall = findCallExpression(sourceFile, 'provideHttpClient');
    if (!httpClientCall) {
      warnManualSetup(context, filePath);
      return;
    }

    const recorder = tree.beginUpdate(filePath);

    const interceptorsCall = httpClientCall.arguments.find(
      (arg): arg is ts.CallExpression =>
        ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'withInterceptors'
    );

    if (interceptorsCall) {
      const [arrayArg] = interceptorsCall.arguments;
      if (!arrayArg || !ts.isArrayLiteralExpression(arrayArg)) {
        warnManualSetup(context, filePath);
        return;
      }

      if (arrayArg.elements.length === 0) {
        recorder.insertLeft(arrayArg.elements.end, 'withHttpCacheInterceptor()');
      } else {
        recorder.insertLeft(arrayArg.elements[arrayArg.elements.length - 1].end, ', withHttpCacheInterceptor()');
      }
    } else {
      const args = httpClientCall.arguments;
      const insertPosition = args.length > 0 ? args[args.length - 1].end : args.end;
      const separator = args.length > 0 ? ', ' : '';
      recorder.insertLeft(insertPosition, `${separator}withInterceptors([withHttpCacheInterceptor()])`);
      insertNamedImport(recorder, sourceFile, 'withInterceptors', HTTP_PACKAGE);
    }

    insertNamedImport(recorder, sourceFile, 'withHttpCacheInterceptor', CASHEW_PACKAGE);
    tree.commitUpdate(recorder);
  };
}

function warnManualSetup(context: SchematicContext, filePath: string): void {
  context.logger.warn(
    `Could not automatically register the cashew interceptor in "${filePath}". Please add it manually:\n${MANUAL_SETUP_SNIPPET}`
  );
}

function findCallExpression(node: ts.Node, name: string): ts.CallExpression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
    return node;
  }

  return ts.forEachChild(node, child => findCallExpression(child, name));
}

/** Adds a named import, merging into an existing import declaration from the same module. */
function insertNamedImport(
  recorder: UpdateRecorder,
  sourceFile: ts.SourceFile,
  symbolName: string,
  moduleName: string
): void {
  let lastImportEnd = 0;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    lastImportEnd = statement.end;

    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const { elements } = statement.importClause.namedBindings;
    if (elements.some(element => element.name.text === symbolName)) {
      return;
    }

    if (elements.length === 0) {
      recorder.insertLeft(elements.end, symbolName);
    } else {
      recorder.insertLeft(elements[elements.length - 1].end, `, ${symbolName}`);
    }

    return;
  }

  const newImport = `import { ${symbolName} } from '${moduleName}';\n`;
  recorder.insertLeft(lastImportEnd, lastImportEnd === 0 ? newImport : `\n${newImport.trimEnd()}`);
}

function findFileContaining(tree: Tree, sourceRoot: string, needle: string): string | undefined {
  const candidates = [`/${sourceRoot}/app/app.config.ts`, `/${sourceRoot}/main.ts`, `/${sourceRoot}/app/app.module.ts`];

  for (const candidate of candidates) {
    if (tree.exists(candidate) && tree.readText(candidate).includes(needle)) {
      return candidate;
    }
  }

  let found: string | undefined;
  tree.getDir(sourceRoot).visit(path => {
    if (!found && path.endsWith('.ts') && !path.endsWith('.spec.ts') && tree.readText(path).includes(needle)) {
      found = path;
    }
  });

  return found;
}

function projectContains(tree: Tree, sourceRoot: string, needle: string): boolean {
  return findFileContaining(tree, sourceRoot, needle) !== undefined;
}
