import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtUsdc } from '../src/lib/format'

void test('USDC display never rounds a decimal string through a JavaScript number', () => {
  assert.equal(fmtUsdc('9007199254740993.01'), '9,007,199,254,740,993.01')
})

void test('whole-USDC summaries round exact strings without losing the integer', () => {
  assert.equal(fmtUsdc('9007199254740993.49', { whole: true }), '9,007,199,254,740,993')
})

void test('compact USDC formatting keeps large aggregate digits exact', () => {
  assert.equal(fmtUsdc('9007199254740998000000000000.00', { compact: true }), '9,007,199,254,740,998T')
})

void test('invalid financial data is unavailable rather than a fabricated zero', () => {
  for (const value of ['', 'not-a-number', '1e6', 'Infinity', '1.0000001']) assert.equal(fmtUsdc(value), '—')
  assert.equal(fmtUsdc(Number.NaN), '—')
})

void test('exact micro-USDC and intentionally compact/whole display remain explicit', () => {
  assert.equal(fmtUsdc('0.000001'), '0.000001')
  assert.equal(fmtUsdc('49.120000'), '49.12')
  assert.equal(fmtUsdc('49.50', { whole: true }), '50')
  assert.equal(fmtUsdc('-49.50', { whole: true }), '-50')
  assert.equal(fmtUsdc('999950', { compact: true }), '1M')
  assert.equal(fmtUsdc('1234', { compact: true }), '1.2K')
})
