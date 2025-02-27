/**
 * @license Copyright (c) 2003-2025, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-licensing-options
 */

/* eslint-env node */

import { constants, readFile, writeFile, copyFile, readdir, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import upath from 'upath';
import { glob } from 'glob';
import { build as esbuild } from 'esbuild';

const require = createRequire( import.meta.url );
const __dirname = upath.dirname( fileURLToPath( import.meta.url ) );

/**
 * @param {Set<Snippet>} snippets Snippet collection extracted from documentation files.
 * @param {Record<string, any>} options
 * @param {Record<string, function>} umbertoHelpers
 * @returns {Promise<void>}
 */
export default async function snippetAdapter( snippets, _options, { getSnippetPlaceholder } ) {
	console.log( 'Started building snippets.' );

	const { snippetsInputPath, snippetsOutputPath } = getPaths( snippets );
	const constants = await getConstantDefinitions( snippets );
	const imports = await getImportMap();

	// Build all JavaScript snippets.
	await buildSnippets(
		await getAllSnippets( snippetsInputPath ),
		snippetsOutputPath,
		constants,
		imports
	);

	// Build all documents and replace the snippet and %BASE_PATH% placeholders with the actual content.
	await buildDocuments(
		snippets,
		getSnippetPlaceholder,
		constants,
		imports
	);

	console.log( 'Finished building snippets.' );
}

/**
 * Returns input and output paths for snippets and other assets.
 *
 * @param {Set<Snippet>} snippets
 * @returns {Record<string, string>}
 */
function getPaths( [ snippet ] ) {
	const version = upath.normalize( snippet.outputPath ).split( upath.sep ).at( -2 );
	const inputPath = upath.normalize( snippet.snippetSources.html ).split( version, 1 ) + version;

	return {
		inputPath,
		outputPath: upath.resolve( snippet.outputPath, '..' ),
		snippetsInputPath: upath.resolve( inputPath, '_snippets' ),
		snippetsOutputPath: snippet.outputPath
	};
}

/**
 * Returns the content of the `package.json` file for a given package.
 *
 * @param {string} packageName
 * @returns {Promise<Record<string, unknown>>}
 */
async function getPackageJson( packageName ) {
	const path = require.resolve( `${ packageName }/package.json` );
	const content = await readFile( path, { encoding: 'utf-8' } );

	return JSON.parse( content );
}

/**
 * Returns snippet files grouped by their name.
 *
 * @param {string} path
 * @returns {Promise<Record<string, SnippetSource>>}
 */
async function getAllSnippets( path ) {
	// TODO: Most of this logic can be removed, if JS files directly import CSS files.
	// Then we can use glob to only search for JS files.

	// Snippets grouped by their name.
	const snippets = {};
	const entries = await readdir( path, { withFileTypes: true, recursive: true } );

	for ( const entry of entries ) {
		if ( entry.isDirectory() ) {
			continue;
		}

		/**
		 * Given that the `snippetsFolder` is `/absolute/path/to`, the following values will be:
		 *
		 * path 					/absolute/path/to/some/resource.html
		 * dir						/absolute/path/to/some
		 * name						resource
		 * ext						.html
		 * snippetName		some/resource
		 */
		const filePath = upath.join( entry.parentPath, entry.name );
		const { dir, name, ext } = upath.parse( filePath );
		const snippetName = upath.relative( path, upath.join( dir, name ) );
		const data = snippets[ snippetName ] ??= {};

		data[ ext.substring( 1 ) ] = filePath;
	}

	return snippets;
}

/**
 * Builds all snippets from the provided paths and saves them to the output path.
 *
 * @param {Record<string, SnippetSource>} snippets
 * @param {string} snippetsOutputPath
 * @param {Record<string, any>} constants
 * @param {Record<string, any>} imports
 */
async function buildSnippets( snippets, snippetsOutputPath, constants, imports ) {
	const external = Object.keys( imports );
	const define = {};

	for ( const definitionKey in constants ) {
		define[ definitionKey ] = JSON.stringify( constants[ definitionKey ] );
	}

	for ( const [ name, files ] of Object.entries( snippets ) ) {
		if ( !files.js ) {
			continue;
		}

		await buildSnippet( name, files, snippetsOutputPath, external, define );
	}
}

/**
 * Builds individual JavaScript snippet.
 *
 * @param {string} name
 * @param {SnippetSource} files
 * @param {string} outputPath
 * @param {Array<string>} externals
 * @param {Record<string, string>} define
 * @returns {Promise<Array<string>>}
 */
async function buildSnippet( name, files, outputPath, externals, define ) {
	const { name: filename, dir, base } = upath.parse( files.js );

	return esbuild( {
		/**
		 * TODO: If all JS snippets directly import CSS files, then we can use `entryPoints`
		 * instead of `stdin` and simplify this.
		 * https://esbuild.github.io/api/#entry-points
		 */
		stdin: {
			contents: `
				${ files.css ? `import './${ filename }.css';` : '' }
				${ await readFile( files.js, { encoding: 'utf-8' } ) }
			`,
			resolveDir: dir,
			sourcefile: base,
			loader: 'jsx'
		},
		entryNames: '[dir]/snippet',
		bundle: true,
		minify: true,
		define,
		outdir: upath.join( outputPath, name ),
		platform: 'browser',
		legalComments: 'none',
		format: 'esm',
		target: 'es2022',
		tsconfigRaw: {},
		loader: {
			'.js': 'jsx',
			'.svg': 'text'
		},
		plugins: [
			/**
			 * Esbuild has an `external` property. However, it doesn't look for direct match, but checks if the path starts
			 * with the provided value. This means that if the `external` array includes `@ckeditor/ckeditor5-core` and we
			 * have an import like `@ckeditor/ckeditor5-core/tests/...`, then it will be marked as external instead of being
       * bundled. This will cause issues, because the `tests` directory is not available in the CDN build.
			 */
			{
				name: 'external',
				setup( build ) {
					build.onResolve( { filter: /.*/ }, args => ( {
						external: externals.some( name => name.endsWith( '/' ) ? args.path.startsWith( name ) : args.path === name )
					} ) );
				}
			}
		]
	} );
}

/**
 * Builds documents and replaces all placeholders with the actual content.
 *
 * @param {Array<Snippet>} snippets
 * @param {function} getSnippetPlaceholder
 * @param {Record<string, any>} constants
 * @param {Record<string, any>} imports
 */
async function buildDocuments( snippets, getSnippetPlaceholder, constants, imports ) {
	const getStyle = href => `<link rel="stylesheet" href="${ href }" data-cke="true" />`;
	const getScript = src => `<script type="module" src="${ src }"></script>`;
	const { snippetsInputPath, snippetsOutputPath, outputPath } = getPaths( snippets );

	// Group snippets by the destination document.
	const documents = await getBootstrapDocumentData( snippetsInputPath, snippetsOutputPath, outputPath );

	// TODO: Use `Object.groupBy` instead, when we migrate to Node 22.
	for ( const snippet of snippets ) {
		documents[ snippet.destinationPath ] ??= [];
		documents[ snippet.destinationPath ].push( snippet );
	}

	// Gather global tags added to each document that do not require relative paths.
	const globalTags = [
		`<script type="importmap">${ JSON.stringify( { imports } ) }</script>`,
		`<script>window.CKEDITOR_GLOBAL_LICENSE_KEY = '${ constants.LICENSE_KEY }';</script>`
	];

	// Iterate over each document and replace placeholders with the actual content.
	for ( const [ document, documentSnippets ] of Object.entries( documents ) ) {
		const relativeOutputPath = upath.relative( upath.dirname( document ), outputPath );

		// Get global tags added to each document that require relative paths.
		const documentTags = [
			...globalTags,
			getStyle( 'https://cdn.ckeditor.com/ckeditor5/nightly-next/ckeditor5.css' ),
			getStyle( 'https://cdn.ckeditor.com/ckeditor5-premium-features/nightly-next/ckeditor5-premium-features.css' ),
			getStyle( upath.join( relativeOutputPath, 'assets', 'snippet-styles.css' ) ),
			getStyle( upath.join( relativeOutputPath, 'snippets', 'assets', 'snippet.css' ) ),
			getScript( upath.join( relativeOutputPath, 'assets', 'snippet.js' ) ),
			getScript( upath.join( relativeOutputPath, 'snippets', 'assets', 'snippet.js' ) )
		];

		let documentContent = await readFile( document, { encoding: 'utf-8' } );

		// Iterate over each snippet in the document and replace placeholders with the actual content.
		for ( const snippet of documentSnippets ) {
			const data = await readFile( snippet.snippetSources.html, { encoding: 'utf-8' } );

			documentContent = documentContent.replace(
				getSnippetPlaceholder( snippet.snippetName ),
				() => '<div class="live-snippet">' + data.replaceAll( /%BASE_PATH%/g, () => snippet.basePath ) + '</div>'
			);

			if ( await fileExists( upath.join( snippet.outputPath, snippet.snippetName, 'snippet.js' ) ) ) {
				documentTags.push( getScript( upath.join( snippet.relativeOutputPath, snippet.snippetName, 'snippet.js' ) ) );
			}

			if ( await fileExists( upath.join( snippet.outputPath, snippet.snippetName, 'snippet.css' ) ) ) {
				documentTags.push( getStyle( upath.join( snippet.relativeOutputPath, snippet.snippetName, 'snippet.css' ) ) );
			}
		}

		documentContent = documentContent
			.replace( '<!--UMBERTO: SNIPPET: CSS-->', () => documentTags.join( '\n' ) )
			.replace( '<!--UMBERTO: SNIPPET: JS-->', () => '' );

		await writeFile( document, documentContent );
	}
}

/**
 * Returns an import map for the CKEditor 5 packages.
 *
 * @returns {Promise<Object<string, string>>}
 */
async function getImportMap() {
	const core = await getPackageJson( 'ckeditor5' );
	const commercial = await getPackageJson( 'ckeditor5-premium-features' );

	const imports = {
		'ckeditor5': 'https://cdn.ckeditor.com/ckeditor5/nightly-next/ckeditor5.js',
		'ckeditor5/': 'https://cdn.ckeditor.com/ckeditor5/nightly-next/',
		'ckeditor5-premium-features': 'https://cdn.ckeditor.com/ckeditor5-premium-features/nightly-next/ckeditor5-premium-features.js',
		'ckeditor5-premium-features/': 'https://cdn.ckeditor.com/ckeditor5-premium-features/nightly-next/'
	};

	/**
	 * Some snippets may use imports from individual packages instead of the main `ckeditor5` or
	 * `ckeditor5-premium-features` packages. In such cases, we need to add these imports to the import map.
	 */
	for ( const dependency of Object.keys( core.dependencies ) ) {
		imports[ dependency ] ||= imports.ckeditor5;
		imports[ `${ dependency }/dist/index.js` ] ||= imports.ckeditor5;
	}

	for ( const dependency of Object.keys( commercial.dependencies ) ) {
		imports[ dependency ] ||= imports[ 'ckeditor5-premium-features' ];
		imports[ `${ dependency }/dist/index.js` ] ||= imports[ 'ckeditor5-premium-features' ];
	}

	return imports;
}

/**
 * Adds constants to the webpack process from external repositories containing `docs/constants.js` files.
 *
 * @param {Array<Snippet>} snippets
 * @returns {Promise<Record<string, unknown>>}
 */
async function getConstantDefinitions( snippets ) {
	const knownPaths = new Set();
	const constantDefinitions = {};
	const constantOrigins = new Map();

	for ( const snippet of snippets ) {
		if ( !snippet.pageSourcePath ) {
			continue;
		}

		let directory = upath.dirname( snippet.pageSourcePath );

		while ( !knownPaths.has( directory ) ) {
			knownPaths.add( directory );

			const constantsFiles = await glob( 'constants.*js', {
				absolute: true,
				cwd: upath.join( directory, 'docs' )
			} );

			for ( const item of constantsFiles ) {
				const importPathToConstants = upath.relative( __dirname, item );

				const { default: packageConstantDefinitions } = await import( './' + importPathToConstants );

				for ( const constantName in packageConstantDefinitions ) {
					const constantValue = packageConstantDefinitions[ constantName ];

					if ( constantDefinitions[ constantName ] && constantDefinitions[ constantName ] !== constantValue ) {
						throw new Error(
							`Definition for the '${ constantName }' constant is duplicated` +
							` (${ importPathToConstants }, ${ constantOrigins.get( constantName ) }).`
						);
					}

					constantDefinitions[ constantName ] = constantValue;
					constantOrigins.set( constantName, importPathToConstants );
				}

				Object.assign( constantDefinitions, packageConstantDefinitions );
			}

			directory = upath.dirname( directory );
		}
	}

	return constantDefinitions;
}

/**
 * Checks if a file exists at the given path.
 *
 * @param {string} path The path to the file.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists( path ) {
	try {
		await access( path, constants.F_OK );

		return true;
	} catch {
		return false;
	}
}

/**
 * The `examples/bootstrap-ui.html` is a special case, because it cannot be inlined like other snippets.
 * This is because it includes Bootstrap assets which leak into the rest of the document, breaking the
 * styles, so, we need to load it in an iframe. This function creates the necessary data for to process
 * this snippet like a regular document, rather than a snippet.
 *
 * @param {string} snippetsInputPath
 * @param {string} snippetsOutputPath
 * @param {string} outputPath
 * @returns {Promise<Record<string, unknown>>}
 */
async function getBootstrapDocumentData( snippetsInputPath, snippetsOutputPath, outputPath ) {
	const destinationPath = upath.join( snippetsOutputPath, 'examples', 'bootstrap-ui.html' );
	const basePath = upath.relative( upath.dirname( destinationPath ), outputPath );

	const snippet = {
		basePath,
		destinationPath,
		outputPath: snippetsOutputPath,
		pageSourcePath: '',
		relativeOutputPath: upath.join( basePath, 'snippets' ),
		snippetName: 'examples/bootstrap-ui',
		snippetSources: {
			html: upath.join( snippetsInputPath, 'examples', 'bootstrap-ui.html' ),
			js: upath.join( snippetsInputPath, 'examples', 'bootstrap-ui.js' )
		}
	};

	await copyFile( snippet.snippetSources.html, destinationPath );

	return {
		[ destinationPath ]: [ snippet ]
	};
}

/**
 * @typedef {Object} Snippet
 * @property {SnippetSource} snippetSources Sources of the snippet.
 * @property {string} snippetName Name of the snippet. Defined directly after `@snippet` tag.
 * @property {string} outputPath An absolute path where to write file produced by the `snippetAdapter`.
 * @property {string} destinationPath An absolute path to the file where the snippet is being used.
 * @property {string} basePath Relative path from the processed file to the root of the documentation.
 * @property {string} relativeOutputPath The same like `basePath` but for the output path (where processed file will be saved).
 */

/**
 * @typedef {Object} SnippetSource
 * @property {string} html An absolute path to the HTML sample.
 * @property {string} css An absolute path to the CSS sample.
 * @property {string} js An absolute path to the JS sample.
 */
