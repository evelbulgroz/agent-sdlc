import ts from 'typescript';

const QUANTITY_MODULE = '@evelbulgroz/quantity-class';
const OWNED_STATIC_METHODS = new Set(['create', 'parse']);
const OWNED_INSTANCE_METHODS = new Set(['equals', 'toJSON']);
const FORBIDDEN_INSTANCE_PROPERTIES = new Set(['unit', 'value']);

export interface QuantityApiSignal {
	readonly kind: string;
	readonly member: string;
	readonly filePath: string;
	readonly line: number;
	readonly column: number;
	readonly moduleSpecifier?: string;
	readonly expectedModule?: string;
}

export interface LocalQuantityApiAnalysis {
	readonly violations: readonly QuantityApiSignal[];
	readonly apiGaps: readonly QuantityApiSignal[];
}

function location(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): { line: number; column: number } {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { line: line + 1, column: character + 1 };
}

function isNamedType(
	node: ts.TypeNode | undefined,
	names: ReadonlySet<string>,
): boolean {
	return Boolean(
		node &&
			ts.isTypeReferenceNode(node) &&
			ts.isIdentifier(node.typeName) &&
			names.has(node.typeName.text),
	);
}

export function analyzeLocalQuantityApi(
	source: string,
	filePath = 'source.ts',
): Readonly<LocalQuantityApiAnalysis> {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const quantityNames = new Set<string>();
	const violations: QuantityApiSignal[] = [];
	const apiGaps: QuantityApiSignal[] = [];
	const seen = new Set<string>();
	const record = (
		collection: QuantityApiSignal[],
		kind: string,
		member: string,
		node: ts.Node,
		details: { moduleSpecifier?: string; expectedModule?: string } = {},
	): void => {
		const point = location(sourceFile, node);
		const key = `${kind}:${member}:${point.line}:${point.column}`;
		if (seen.has(key)) return;
		seen.add(key);
		collection.push(Object.freeze({ kind, member, filePath, ...point, ...details }));
	};
	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier)
		) {
			continue;
		}
		const clause = statement.importClause;
		if (clause?.name?.text === 'Quantity') {
			if (statement.moduleSpecifier.text === QUANTITY_MODULE) {
				quantityNames.add(clause.name.text);
			} else {
				record(
					violations,
					'quantity-import-source',
					'Quantity',
					statement.moduleSpecifier,
					{
						moduleSpecifier: statement.moduleSpecifier.text,
						expectedModule: QUANTITY_MODULE,
					},
				);
			}
		}
		const namedElements =
			clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
				? clause.namedBindings.elements
				: [];
		for (const element of namedElements) {
			if ((element.propertyName ?? element.name).text === 'Quantity') {
				if (statement.moduleSpecifier.text === QUANTITY_MODULE) {
					quantityNames.add(element.name.text);
				} else {
					record(
						violations,
						'quantity-import-source',
						'Quantity',
						statement.moduleSpecifier,
						{
							moduleSpecifier: statement.moduleSpecifier.text,
							expectedModule: QUANTITY_MODULE,
						},
					);
				}
			}
		}
	}
	if (quantityNames.size === 0) {
		return Object.freeze({
			violations: Object.freeze(violations),
			apiGaps: Object.freeze(apiGaps),
		});
	}

	const quantityValues = new Set<string>();
	const collectValues = (node: ts.Node): void => {
		if (
			(ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
			ts.isIdentifier(node.name) &&
			isNamedType(node.type, quantityNames)
		) {
			quantityValues.add(node.name.text);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer
		) {
			if (
				ts.isNewExpression(node.initializer) &&
				ts.isIdentifier(node.initializer.expression) &&
				quantityNames.has(node.initializer.expression.text)
			) {
				quantityValues.add(node.name.text);
			}
			if (
				ts.isCallExpression(node.initializer) &&
				ts.isPropertyAccessExpression(node.initializer.expression) &&
				ts.isIdentifier(node.initializer.expression.expression) &&
				quantityNames.has(node.initializer.expression.expression.text) &&
				OWNED_STATIC_METHODS.has(node.initializer.expression.name.text)
			) {
				quantityValues.add(node.name.text);
			}
		}
		ts.forEachChild(node, collectValues);
	};
	collectValues(sourceFile);

	const inspect = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node)) {
			const member = node.name.text;
			const directQuantity =
				ts.isIdentifier(node.expression) && quantityValues.has(node.expression.text);
			const staticQuantity =
				ts.isIdentifier(node.expression) && quantityNames.has(node.expression.text);
			if (directQuantity && FORBIDDEN_INSTANCE_PROPERTIES.has(member)) {
				record(violations, 'quantity-direct-wire-access', member, node.name);
			}
			if (
				ts.isCallExpression(node.parent) &&
				node.parent.expression === node &&
				directQuantity &&
				!OWNED_INSTANCE_METHODS.has(member)
			) {
				record(apiGaps, 'quantity-inherited-instance-method', member, node.name);
			}
			if (
				ts.isCallExpression(node.parent) &&
				node.parent.expression === node &&
				staticQuantity &&
				!OWNED_STATIC_METHODS.has(member)
			) {
				record(apiGaps, 'quantity-unowned-static-method', member, node.name);
			}
		}
		ts.forEachChild(node, inspect);
	};
	inspect(sourceFile);
	return Object.freeze({
		violations: Object.freeze(violations),
		apiGaps: Object.freeze(apiGaps),
	});
}
