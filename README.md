# MIIT Verification Flow — Technical Notes

The slider is the visible part of the MIIT verification page, but it is not the whole security model. The more interesting structure is the sequence around it: an API token, a challenge session, image coordinates, and a signed value produced by a successful check.

## 1. Four separate layers

The observed flow can be understood as four layers:

```text
Edge protection
→ API token
→ Image challenge
→ Business signature
```

The edge layer deals with browser traffic. The API layer expects a token obtained from `/api/auth`. The image layer issues a challenge and checks the answer. Finally, the business layer asks for a `sign` produced by a successful image check.

These layers use different values, so obtaining one of them does not automatically satisfy the others.

## 2. Token and challenge exchange

The auth request contains `authKey` and `timeStamp`. In the examined build, the key is an MD5 value derived from a fixed account string, a fixed secret, and the current timestamp.

The response contains a `bussiness` token. Its payload includes timing information, and later API requests carry it in the `token` header. This makes the token part of the request state rather than a value that can be omitted after the first call.

The challenge request then returns the background, puzzle piece, UUID, and vertical position. The UUID identifies that particular image challenge and is needed again when the answer is submitted.

## 3. What the image reveals

The puzzle does not require a complicated vision model. Its useful feature is the contrast between the gap and the surrounding image.

A candidate window can be scored using three observations:

- how bright the window is
- how bright its neighboring strips are
- how much texture variation exists inside it

In the samples examined, a bright and relatively flat gap produces a useful peak. Nearby peaks can be grouped before a small Sobel pass aligns the result with a vertical edge.

The important analytical step is to look at local statistics rather than search for a fixed image template. Backgrounds change, but the relationship between the gap and its immediate surroundings remains useful.

The submitted horizontal coordinate is in the image's own coordinate space. The response also depends on the challenge UUID, so the image answer and the challenge session cannot be treated independently.

## 4. The role of the signature

A successful `checkImage` response returns a signed value. Its importance is not limited to the image result: it connects the answer to the challenge UUID and provides proof that this particular challenge was completed.

This is where the CAPTCHA becomes part of a wider authorization flow. The signed response belongs to the active session rather than acting as a reusable answer to an isolated puzzle.

## 5. The useful analytical approach

The cleanest way to understand the system is to separate its state instead of trying to solve everything at once. Token issuance, image analysis, and signature validation can be examined independently, then followed as one continuous exchange.

Browser context also matters. Cookies, token headers, and challenge values belong to the same session. Replaying isolated fields from different runs loses the relationships that make the request coherent.

The central observation is that the image itself is only one link. The complete verification depends on preserving the sequence from auth to challenge and from challenge to signature.
