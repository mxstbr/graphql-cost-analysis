import {
  parse,
  TypeInfo,
  ValidationContext,
  visit,
  visitWithTypeInfo
} from 'graphql'
import { makeExecutableSchema } from 'graphql-tools'
import CostAnalysis from './costAnalysis'

const customCost = 8
const firstComplexity = 2
const secondComplexity = 5
const thirdComplexity = 6

const typeDefs = `
  interface BasicInterface {
    string: String
    int: Int
  }

  type Query {
    defaultCost: Int
    costWithoutMultipliers: Int @cost(useMultipliers: false, complexity: ${customCost})
    customCost: Int @cost(useMultipliers: false, complexity: ${customCost})
    badComplexityArgument: Int @cost(complexity: 12)
    customCostWithResolver(limit: Int): Int @cost(
      multiplier: "limit", useMultipliers: true, complexity: 4
    )

    # for recursive cost
    first (limit: Int): First @cost(
      multiplier: "limit", useMultipliers: true, complexity: ${firstComplexity}
    )

    overrideTypeCost: TypeCost @cost(complexity: 2)
    getCostByType: TypeCost
  }

  type First implements BasicInterface {
    string: String
    int: Int
    second (limit: Int): Second @cost(
      multiplier: "limit", useMultipliers: true, complexity: ${secondComplexity}
    )
  }

  type Second implements BasicInterface {
    string: String
    int: Int
    third (limit: Int): String @cost(
      multiplier: "limit", useMultipliers: true, complexity: ${thirdComplexity}
    )
  }

  type TypeCost @cost(complexity: 3) {
    string: String
    int: Int
  }

  schema {
    query: Query
  }
`

const resolvers = {
  Query: {
    defaultCost: () => 1,
    customCost: () => 2,
    customCostWithResolver: (root, { limit }, context) => limit,
    first: (root, { limit }, context) => ({
      string: 'first',
      int: 1
    })
  }
}

const schema = makeExecutableSchema({ typeDefs, resolvers })

describe('Cost analysis Tests', () => {
  const typeInfo = new TypeInfo(schema)

  test('should consider default cost', () => {
    const ast = parse(`
      query {
        defaultCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(0)
  })

  test('should enable to set the value of the default cost', () => {
    const defaultCost = 12
    const ast = parse(`
      query {
        defaultCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      defaultCost
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(defaultCost)
  })

  test('should consider custom scalar cost', () => {
    const ast = parse(`
      query {
        customCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(customCost)
  })

  test('should consider recursive cost computation', () => {
    const limit = 10
    const ast = parse(`
      query {
        first(limit: ${limit}) {
          second(limit: ${limit}) {
            third(limit: ${limit})
          }
        }
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 10000
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))

    const firstCost = limit * firstComplexity
    const secondCost = limit * limit * secondComplexity
    const thirdCost = limit * limit * limit * thirdComplexity

    const result = firstCost + secondCost + thirdCost
    expect(visitor.cost).toEqual(result)
    expect(visitor.multipliers).toEqual([ limit, limit, limit ])
  })

  test(
    `should consider recursive cost computation + empty
    multipliers array when the node is of kind operation definition`, () => {
      const limit = 10
      const ast = parse(`
        query {
          first(limit: ${limit}) {
            second(limit: ${limit}) {
              third(limit: ${limit})
            }
          }
          customCost
        }
      `)

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 10000
      })

      visit(ast, visitWithTypeInfo(typeInfo, visitor))

      const firstCost = limit * firstComplexity
      const secondCost = limit * limit * secondComplexity
      const thirdCost = limit * limit * limit * thirdComplexity

      const result = firstCost + secondCost + thirdCost + customCost
      expect(visitor.cost).toEqual(result)
      // visitor.multipliers should be empty at the end
      // because customCost is another node in the Query type
      // and customCost has no multiplier arg itself
      expect(visitor.multipliers).toEqual([])
    })

  test('should report error if the maximum cost is reached', () => {
    const ast = parse(`
      query {
        customCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 1
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))

    expect(context.getErrors().length).toEqual(1)
    expect(context.getErrors()[0].message).toEqual(
      `The query exceeds the maximum cost of 1. Actual cost is ${customCost}`
    )
  })

  test('should report error if the complexity argument is not between 1 and 10', () => {
    const ast = parse(`
      query {
        badComplexityArgument
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 1000
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(context.getErrors().length).toEqual(1)
    expect(context.getErrors()[0].message).toEqual(
      'The complexity argument must be between 1 and 10'
    )
  })

  test('should not allow negative cost', () => {
    const ast = parse(`
      query {
        customCostWithResolver(limit: -10)
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(0)
  })

  test('a cost directive defined on a field should override ' +
  'the cost directive defined on the type definition', () => {
    const ast = parse(`
      query {
        overrideTypeCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(2)
  })

  test('if a field returns a specific type and the type has a cost directive and ' +
  'the field does not have a cost directive, the cost will be of that type', () => {
    const ast = parse(`
      query {
        getCostByType
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(3)
  })

  test('if costMap option is provided, we compute the score with it', () => {
    const limit = 15
    const ast = parse(`
      query {
        first(limit: ${limit})
      }
    `)

    const costMap = {
      Query: {
        first: {
          multiplier: 'limit',
          useMultipliers: true,
          complexity: 3
        }
      }
    }

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      costMap
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    const expectedCost = costMap.Query.first.complexity * limit
    expect(visitor.cost).toEqual(expectedCost)
  })

  test('if costMap node is undefined, return the defaultCost', () => {
    const ast = parse(`
      query {
        first(limit: 10)
      }
    `)

    const costMap = {}
    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      costMap
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(visitor.defaultCost)
  })
})
