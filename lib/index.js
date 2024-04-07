import { promises as fs } from "node:fs";
import path from "node:path";
import resolve from "enhanced-resolve";


const firstReplaceRegexp = /\/(?:\\.)+\/|(?:\\.)+/g;
const secondReplaceRegexp = /("[^"\n]*?"|`[^`]*?`|'[^'\n]*?'|(?<=[\w$)])\s*\/(?![*/]))|\/(?!\*)(?:(?:\[[^\]]*\])|[^/])+\/|\/\*[\S\s]+?\*\/|\/\/.*$/gm;
const matchRegexp = /"[^"\n]*?"|`[^`]*?`|'[^'\n]*?'|(?<!\w|\$)(?:import\s*(?:[\w+$\s*,]*(?:\{[^}]+\}\s*)?from\s*)?|export\s*(?:\*(?:\s*as\s+[\w$]+\s+|\s*)|\{[^}]+\}\s*)from\s*|(?:import|require)\s*\(\s*)("|'|`)([^"'`+]+)\1/g;
const fromRegexp = /^[^"'`]+("|'|`)([^"'`]+)\1/;
const nodeModulesRegexp = /\/node_modules\//;
const nameRegexp = /^\/.*\/node_modules\/((?:@[\w-]+\/)?[\w-]+)\/.*$/;

function getPackageName(packagePath) {
	return nodeModulesRegexp.test(packagePath) ? path.replace(nameRegexp, "$1") : null;
}

function parse(fileName, config) {
	return Promise.all([
		fs.readFile(fileName, "utf8").then(source => {
			const importPaths = source
				.replace(firstReplaceRegexp, "")
				.replace(secondReplaceRegexp, "$1")
				.match(matchRegexp)
				?.map(from => from.match(fromRegexp)?.[2])
				.filter(Boolean);
			
			if (importPaths) {
				const { files, depthMap, resolveDepth, packages } = config;
				
				const dirname = path.dirname(fileName);
				const name = getPackageName(fileName);
				const depth = depthMap?.get(fileName);
				
				packages?.add(name);
				
				// eslint-disable-next-line array-callback-return
				return Promise.all(importPaths.map(importPath => {
					for (const [ aliasRegexp, aliasPath ] of config.aliasesMap)
						if (aliasRegexp.test(importPath)) {
							importPath = importPath.replace(aliasRegexp, `${aliasPath}$1`);
							break;
						}
					
					try {
						const dependency = config.resolver(dirname, importPath);
						const dependencyDepth = depthMap && (getPackageName(dependency) === name ? depth : Math.min(depth + 1, depthMap.get(dependency) ?? resolveDepth));
						
						if (!files.includes(dependency) && (!depthMap || dependencyDepth < resolveDepth)) {
							files.push(dependency);
							depthMap?.set(dependency, dependencyDepth);
							
							return parse(dependency, config);
						}
					} catch {}
				}).filter(Boolean));
			}
		}),
		config.lastMtimeMs && fs.stat(fileName).then(({ mtimeMs }) => {
			if (mtimeMs > config.lastMtimeMs)
				config.lastMtimeMs = mtimeMs;
			
		})
	]);
}


export async function depsList(input, options = {}) {
	if (!Array.isArray(input))
		input = [ input ];
	
	const {
		cwd = process.cwd(),
		aliases,
		extensions,
		resolveDepth = Infinity,
		lastMtimeMs = true,
		packages,
		
		conditionNames = [ "import", "require", "node" ],
		mainFields = [ "module", "main" ],
		...enhancedResolveOptions
	} = options;
	
	for (let i = 0; i < input.length; i++)
		if (!path.isAbsolute(input[i]))
			input[i] = path.resolve(cwd, input[i]);
	
	const aliasesMap = new Map(aliases ? Object.entries(aliases).map(([ alias, aliasPath ]) => [ new RegExp(`^${alias.replace(/\$/, "\\$")}(/.*)?$`), path.resolve(cwd, aliasPath) ]) : undefined);
	
	const files = [ ...input ];
	
	const depthMap = isFinite(resolveDepth) ? new Map(input.map(item => [ item, 0 ])) : null;
	
	if (!enhancedResolveOptions.modules)
		enhancedResolveOptions.modules = [ "node_modules", path.resolve(cwd, "node_modules") ];
	
	const resolver = resolve.create.sync({
		conditionNames,
		extensions,
		mainFields,
		...enhancedResolveOptions
	});
	
	const config = {
		aliasesMap,
		files,
		resolveDepth,
		depthMap,
		lastMtimeMs: lastMtimeMs && -Infinity,
		resolver,
		packages: packages ? new Set() : undefined
	};
	
	await Promise.all(input.map(item => parse(item, config)));
	
	const results = { files };
	
	if (lastMtimeMs)
		results.lastMtimeMs = config.lastMtimeMs;
	
	if (packages)
		results.packages = [ ...config.packages ];
	
	return results;
}
