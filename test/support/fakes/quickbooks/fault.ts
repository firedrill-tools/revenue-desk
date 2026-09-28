/** QuickBooks Online errors: the Fault envelope's codes the fake uses. */

/** A QuickBooks error the fake answers with (HTTP 400 unless given). */
export class QboFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: string,
    readonly options: {
      readonly status?: number;
      readonly type?: string;
      readonly element?: string;
    } = {},
  ) {
    super(message);
  }
}

export const notFound = () =>
  new QboFault(
    "610",
    "Object Not Found",
    "Object Not Found : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.",
  );
export const requiredMissing = (param: string) =>
  new QboFault(
    "2020",
    "Required param missing, need to supply the required value for the API",
    `Required parameter ${param} is missing in the request`,
    { element: param },
  );
export const invalidReference = (what: string, id: string) =>
  new QboFault(
    "2500",
    "Invalid Reference Id",
    `Invalid Reference Id : ${what} ${id} does not exist`,
    {
      element: what,
    },
  );
export const unsupportedProperty = (name: string) =>
  new QboFault(
    "2010",
    "Request has invalid or unsupported property",
    `Property Name:Unrecognized field "${name}" specified value is not supported`,
    { element: name },
  );
export const businessRule = (detail: string) =>
  new QboFault(
    "6000",
    "A business validation error has occurred while processing your request",
    `Business Validation Error: ${detail}`,
  );
