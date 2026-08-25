// The difference between "the server cannot take another farm right now" and
// "the server is broken".
//
// Both used to arrive at the same catch and leave as 503 with the exception
// text attached, which got it wrong in both directions: a host watching for
// capacity saw a disk that could not be written to and sized up, and whoever
// asked got a sentence about the server's insides. Capacity is a number a host
// chose and can change; anything else is a fault, and the only honest answer to
// a fault is that something went wrong.
export class AtCapacity extends Error {
  constructor(what) {
    super(what)
    this.name = 'AtCapacity'
  }
}
