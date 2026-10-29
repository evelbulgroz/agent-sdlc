import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLocalQuantityApi } from './local-api-signals.ts';

test('Quantity local API analysis rejects direct wire fields and accepts facade methods', () => {
	const result = analyzeLocalQuantityApi(`
		import { Quantity } from '@evelbulgroz/quantity-class';
		function inspect(quantity: Quantity) {
			const wire = quantity.toJSON();
			return quantity.value + quantity.unit.length + wire.value;
		}
	`);
	assert.deepEqual(
		result.violations.map(({ kind, member }) => ({ kind, member })),
		[
			{ kind: 'quantity-direct-wire-access', member: 'value' },
			{ kind: 'quantity-direct-wire-access', member: 'unit' },
		],
	);
	assert.deepEqual(result.apiGaps, []);
});

test('Quantity local API analysis flags inherited methods without rejecting them', () => {
	const result = analyzeLocalQuantityApi(`
		import { Quantity as LocalQuantity } from '@evelbulgroz/quantity-class';
		const distance = new LocalQuantity(10, 'm');
		const converted = distance.to('km');
		const equal = distance.equals(converted);
	`);
	assert.deepEqual(result.violations, []);
	assert.deepEqual(
		result.apiGaps.map(({ kind, member }) => ({ kind, member })),
		[{ kind: 'quantity-inherited-instance-method', member: 'to' }],
	);
});

test('Quantity local API analysis ignores unrelated value and unit properties', () => {
	const result = analyzeLocalQuantityApi(`
		import { Quantity } from '@evelbulgroz/quantity-class';
		const dto = { value: 10, unit: 'm' };
		const quantity = Quantity.create(dto);
		return { value: dto.value, unit: dto.unit, json: quantity.toJSON() };
	`);
	assert.deepEqual(result.violations, []);
	assert.deepEqual(result.apiGaps, []);
});

test('Quantity local API analysis rejects named imports from noncanonical modules', () => {
	for (const moduleSpecifier of [
		'@fixture/quantity',
		'../../libraries/quantity/quantity.js',
		'@fixture/shared-base',
	]) {
		const result = analyzeLocalQuantityApi(`
			import { Quantity } from '${moduleSpecifier}';
			const ascent = Quantity.create(5, 'm');
		`);
		assert.deepEqual(
			result.violations.map(({ kind, member, moduleSpecifier: actual, expectedModule }) => ({
				kind,
				member,
				moduleSpecifier: actual,
				expectedModule,
			})),
			[
				{
					kind: 'quantity-import-source',
					member: 'Quantity',
					moduleSpecifier,
					expectedModule: '@evelbulgroz/quantity-class',
				},
			],
		);
	}
});

test('Quantity local API analysis accepts an aliased canonical named import', () => {
	const result = analyzeLocalQuantityApi(`
		import { Quantity as LocalQuantity } from '@evelbulgroz/quantity-class';
		const ascent = new LocalQuantity(5, 'm');
	`);
	assert.deepEqual(result.violations, []);
});

test('Quantity local API analysis checks default sources and accepts type-only canonical imports', () => {
	const invalid = analyzeLocalQuantityApi(`
		import Quantity from '@fixture/shared-base';
		const ascent = Quantity.create(5, 'm');
	`);
	assert.equal(invalid.violations[0]?.kind, 'quantity-import-source');
	assert.equal(invalid.violations[0]?.moduleSpecifier, '@fixture/shared-base');

	const typeOnly = analyzeLocalQuantityApi(`
		import type { Quantity } from '@evelbulgroz/quantity-class';
		export type Elevation = Quantity;
	`);
	assert.deepEqual(typeOnly.violations, []);
});
