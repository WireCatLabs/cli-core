### Fixed

- **`models search-consents set` names the cost of the chosen model.** The consent text said "with claude-haiku-5-5
  one costs about $0.0003" whatever model was chosen. It now prices one search with the chosen model (about $0.0005
  with gpt-4o-mini), and says the cost is unknown for a model or address with no known price.
