export class DurableBusy extends Error {
  readonly code = 'busy' as const

  constructor(message = 'conversation is busy') {
    super(message)
    this.name = 'DurableBusy'
  }
}

export class DurableClosed extends Error {
  readonly code = 'closed' as const

  constructor(message = 'durable runtime is closed') {
    super(message)
    this.name = 'DurableClosed'
  }
}

export class DurableFault extends Error {
  readonly code = 'fault' as const

  constructor(message: string) {
    super(message)
    this.name = 'DurableFault'
  }
}
