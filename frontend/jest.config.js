module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
    'lib/**/*.ts',
    'lib/**/*.tsx',
    '!lib/**/*.d.ts',
  ],
};
