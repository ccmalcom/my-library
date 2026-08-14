module.exports = {
  preset: 'ts-jest',
  // Default stays 'node' so the existing pure-logic suites in lib/__tests__ keep
  // their environment. Component tests opt in per file with a
  // `/** @jest-environment jsdom */` docblock.
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  collectCoverageFrom: ['lib/**/*.ts', 'lib/**/*.tsx', '!lib/**/*.d.ts'],
  // vitest owns lib/server/ and app/api/ (see vitest.config.ts). jest owns
  // everything else, which is why component tests under components/ live here.
  testPathIgnorePatterns: ['<rootDir>/lib/server/', '<rootDir>/app/api/'],
  // tsconfig maps '@/*' -> './*'; jest needs that spelled out separately or any
  // component importing '@/lib/...' fails to resolve.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
