# Test Suite Documentation

This directory contains comprehensive unit and integration tests for the CloudFormation Graph Parser.

## Test Structure

### `parser.test.ts`
Tests for the CloudFormation template parser functionality.

**Coverage:**
- Single template parsing
  - Simple templates with basic resources
  - DependsOn relationships (single and multiple)
  - Ref intrinsic functions
  - Fn::GetAtt intrinsic functions
  - Exports in outputs
- Multi-stack parsing
  - Multiple independent stacks
  - Cross-stack references with Fn::ImportValue
  - Multiple imports from same export
- Edge cases
  - Empty templates
  - Resources without properties
  - Nested Ref in complex structures
  - Resource metadata

### `graph.test.ts`
Tests for the graph data structure and operations.

**Coverage:**
- Node operations
  - Adding nodes
  - Getting all nodes
  - Removing nodes
  - Getting nodes by stack
  - Getting all stacks
- Edge operations
  - Adding edges
  - Validation (non-existent nodes)
  - Removing edges
  - Getting all edges
  - Getting dependencies and dependents
  - Cross-stack edge filtering
- Export operations
  - Registering exports
  - Getting export nodes
  - Getting all exports
  - Export cleanup on node removal
- Node movement
  - Renaming within same stack
  - Moving to different stack
  - Edge updates during moves
  - Error handling (target exists, node doesn't exist)
  - In-stack to cross-stack reference conversion
  - Export registration updates
- Utility methods
  - Getting stack ID from qualified ID
  - Getting logical ID from qualified ID

### `generator.test.ts`
Tests for CloudFormation template generation from graphs.

**Coverage:**
- Single stack generation
  - Simple templates
  - DependsOn relationships (single and multiple)
  - Exports in outputs
  - Resource metadata
  - Cross-stack DependsOn exclusion
- Multi-stack generation
  - Multiple templates
  - Stack isolation
- Cross-stack reference transformation
  - Ref to Fn::ImportValue conversion
  - Moved nodes with converted references
- Round-trip consistency
  - Template structure preservation
  - Export preservation
- Edge cases
  - Empty graphs
  - Resources without properties
  - Complex nested properties

### `integration.test.ts`
End-to-end integration tests covering complete workflows.

**Coverage:**
- Complete workflows
  - Parse-manipulate-generate cycle
  - Multi-stack with cross-stack references
- Node movement scenarios
  - Moving within same stack (rename)
  - Moving across stacks
  - In-stack reference to cross-stack import conversion
  - Moving resources with multiple dependencies
- Complex scenarios
  - Circular dependencies
  - Deeply nested resource references
  - Resource removal and regeneration
- Utility functions
  - parseNodeId and createNodeId
  - Complex logical IDs
  - Invalid ID handling

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- parser.test.ts

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:coverage
```

## Test Coverage Goals

The test suite aims for:
- **Line coverage**: >90%
- **Branch coverage**: >85%
- **Function coverage**: >90%

## Key Test Scenarios

### 1. Basic Parsing
Ensures templates are correctly parsed into graph structures with proper node and edge creation.

### 2. Cross-Stack References
Validates that Fn::ImportValue and Export are correctly linked across multiple stacks.

### 3. Node Movement
Tests the critical functionality of moving resources between stacks, including:
- Automatic export creation
- Reference type conversion (Ref → Fn::ImportValue)
- Edge metadata updates

### 4. Round-Trip Consistency
Verifies that templates can be parsed and regenerated without losing information.

### 5. Error Handling
Ensures proper error messages for invalid operations like:
- Adding edges with non-existent nodes
- Moving to existing locations
- Invalid node IDs

## Adding New Tests

When adding new functionality:

1. Add unit tests in the appropriate test file
2. Add integration tests if the feature involves multiple components
3. Test both success and error cases
4. Include edge cases and boundary conditions
5. Update this README with new test coverage

## Test Utilities

The tests use Jest's built-in matchers:
- `expect().toBe()` - Strict equality
- `expect().toEqual()` - Deep equality
- `expect().toBeDefined()` - Value is not undefined
- `expect().toContain()` - Array/string contains value
- `expect().toHaveLength()` - Array/string length
- `expect().toThrow()` - Function throws error
- `expect().toHaveProperty()` - Object has property
