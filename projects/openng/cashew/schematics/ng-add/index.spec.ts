import { logging } from '@angular-devkit/core';
import { SchematicTestRunner, UnitTestTree } from '@angular-devkit/schematics/testing';
import * as path from 'path';

const collectionPath = path.join(__dirname, '../collection.json');
const appConfigPath = '/projects/app/src/app/app.config.ts';

describe('ng-add schematic', () => {
  let runner: SchematicTestRunner;
  let appTree: UnitTestTree;

  const workspaceOptions = {
    name: 'workspace',
    newProjectRoot: 'projects',
    version: '20.0.0'
  };

  const createApp = async (standalone: boolean): Promise<UnitTestTree> => {
    let tree = await runner.runExternalSchematic('@schematics/angular', 'workspace', workspaceOptions);
    tree = await runner.runExternalSchematic(
      '@schematics/angular',
      'application',
      { name: 'app', standalone, skipTests: true },
      tree
    );
    return tree;
  };

  const collectWarnings = (): string[] => {
    const warnings: string[] = [];
    runner.logger.subscribe((entry: logging.LogEntry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message);
      }
    });
    return warnings;
  };

  beforeEach(() => {
    runner = new SchematicTestRunner('@openng/cashew', collectionPath);
  });

  describe('standalone application', () => {
    beforeEach(async () => {
      appTree = await createApp(true);
    });

    it('should add provideHttpClient with the interceptor and provideHttpCache to a fresh app', async () => {
      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig).toContain('provideHttpClient(withInterceptors([withHttpCacheInterceptor()]))');
      expect(appConfig).toContain('provideHttpCache()');
      expect(appConfig).toMatch(/import \{.*provideHttpClient.*\} from '@angular\/common\/http'/);
      expect(appConfig).toMatch(/import \{.*withInterceptors.*\} from '@angular\/common\/http'/);
      expect(appConfig).toMatch(/import \{.*withHttpCacheInterceptor.*\} from '@openng\/cashew'/);
      expect(appConfig).toMatch(/import \{.*provideHttpCache.*\} from '@openng\/cashew'/);
    });

    it('should add withInterceptors to an existing provideHttpClient call without features', async () => {
      appTree.overwrite(
        appConfigPath,
        `import { ApplicationConfig } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient()]
};
`
      );

      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig).toContain('provideHttpClient(withInterceptors([withHttpCacheInterceptor()]))');
      expect(appConfig).toMatch(/import \{ provideHttpClient, withInterceptors \} from '@angular\/common\/http'/);
      expect(appConfig).toMatch(/import \{.*withHttpCacheInterceptor.*\} from '@openng\/cashew'/);
      expect(appConfig).toContain('provideHttpCache()');
    });

    it('should append the interceptor to an existing withInterceptors array', async () => {
      appTree.overwrite(
        appConfigPath,
        `import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(withFetch(), withInterceptors([authInterceptor]))]
};
`
      );

      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig).toContain(
        'provideHttpClient(withFetch(), withInterceptors([authInterceptor, withHttpCacheInterceptor()]))'
      );
      expect(appConfig).toContain('provideHttpCache()');
      // no duplicated withInterceptors feature
      expect(appConfig.match(/withInterceptors\(/g)).toHaveLength(1);
    });

    it('should add withInterceptors to an empty interceptors array', async () => {
      appTree.overwrite(
        appConfigPath,
        `import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(withInterceptors([]))]
};
`
      );

      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig).toContain('provideHttpClient(withInterceptors([withHttpCacheInterceptor()]))');
    });

    it('should be idempotent', async () => {
      let tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      tree = await runner.runSchematic('ng-add', { project: 'app' }, tree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig.match(/withHttpCacheInterceptor\(\)/g)).toHaveLength(1);
      expect(appConfig.match(/provideHttpCache\(\)/g)).toHaveLength(1);
    });

    it('should use the default project when none is specified', async () => {
      const tree = await runner.runSchematic('ng-add', {}, appTree);
      const appConfig = tree.readContent(appConfigPath);

      expect(appConfig).toContain('provideHttpCache()');
    });
  });

  describe('NgModule application', () => {
    beforeEach(async () => {
      appTree = await createApp(false);
    });

    const findModuleFile = (tree: UnitTestTree): string => {
      const moduleFile = tree.files.find(file => /app[.-]module\.ts$/.test(file));
      if (!moduleFile) {
        throw new Error('AppModule file not found');
      }
      return moduleFile;
    };

    it('should add both providers to the root module', async () => {
      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appModule = tree.readContent(findModuleFile(tree));

      expect(appModule).toContain('provideHttpClient(withInterceptors([withHttpCacheInterceptor()]))');
      expect(appModule).toContain('provideHttpCache()');
    });

    it('should not add provideHttpClient when the legacy HttpClientModule is used', async () => {
      const moduleFile = findModuleFile(appTree);
      const original = appTree.readContent(moduleFile);
      appTree.overwrite(
        moduleFile,
        original
          .replace(/imports: \[/, 'imports: [\n    HttpClientModule,')
          .replace(/^/, "import { HttpClientModule } from '@angular/common/http';\n")
      );

      const warnings = collectWarnings();
      const tree = await runner.runSchematic('ng-add', { project: 'app' }, appTree);
      const appModule = tree.readContent(moduleFile);

      expect(appModule).not.toContain('provideHttpClient(');
      expect(appModule).toContain('provideHttpCache()');
      expect(warnings.some(message => message.includes('HttpClientModule'))).toBe(true);
    });
  });

  it('should throw for an unknown project', async () => {
    appTree = await createApp(true);

    await expect(runner.runSchematic('ng-add', { project: 'does-not-exist' }, appTree)).rejects.toThrow(
      /Unable to find project/
    );
  });
});
