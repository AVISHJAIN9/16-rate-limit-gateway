package policy

import (
	"strings"
)

// RouteParam holds a key-value parameter extracted during route pattern matching.
type RouteParam struct {
	Key   string
	Value string
}

// MatchedRoute represents a matched rule and its extracted parameters.
type MatchedRoute struct {
	Policy      Policy
	Params      [4]RouteParam
	ParamCount  int
	Specificity int
}

// ExtractedParams returns the slice of extracted route parameters.
func (m *MatchedRoute) ExtractedParams() []RouteParam {
	return m.Params[:m.ParamCount]
}

// Specificity ranking weights.
const (
	WeightLiteral       = 1000
	WeightParamSingle   = 100
	WeightSuffixWild    = 50
	WeightMultiWildcard = 1
)

type segmentKind uint8

const (
	segLiteral segmentKind = iota
	segParam
	segSingleWildcard
	segSuffixWildcard
	segMultiWildcard
)

type routeNode struct {
	kind        segmentKind
	literal     string
	paramName   string
	suffix      string
	literalMap  map[string]*routeNode
	paramChild  *routeNode
	wildChild   *routeNode
	suffixChild []*routeNode
	multiChild  *routeNode
	policies    []Policy
	methods     map[string]struct{}
	host        string
	specificity int
}

// RadixTree compiles route patterns into a hierarchical prefix tree with wildcard support.
type RadixTree struct {
	root *routeNode
}

// NewRadixTree constructs an empty route tree.
func NewRadixTree() *RadixTree {
	return &RadixTree{
		root: newRouteNode(segLiteral, "", "", ""),
	}
}

func newRouteNode(kind segmentKind, literal, paramName, suffix string) *routeNode {
	return &routeNode{
		kind:       kind,
		literal:    literal,
		paramName:  paramName,
		suffix:     suffix,
		literalMap: make(map[string]*routeNode),
		methods:    make(map[string]struct{}),
	}
}

// ComputeSpecificity computes a deterministic numeric score representing pattern specificity.
func ComputeSpecificity(pattern string) int {
	clean := cleanPathFast(pattern)
	if clean == "" {
		return WeightLiteral
	}
	score := 0
	start := 0
	for i := 0; i <= len(clean); i++ {
		if i == len(clean) || clean[i] == '/' {
			if i > start {
				seg := clean[start:i]
				if seg == "**" || (strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "...}")) {
					score += WeightMultiWildcard
				} else if strings.HasPrefix(seg, "*.") {
					score += WeightSuffixWild
				} else if seg == "*" || (strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}")) {
					score += WeightParamSingle
				} else {
					score += WeightLiteral
				}
			}
			start = i + 1
		}
	}
	return score
}

// Insert adds a policy rule into the radix tree.
func (t *RadixTree) Insert(pattern string, methods []string, host string, p Policy) {
	clean := cleanPathFast(pattern)
	var segments []string
	if clean != "" {
		start := 0
		for i := 0; i <= len(clean); i++ {
			if i == len(clean) || clean[i] == '/' {
				if i > start {
					segments = append(segments, clean[start:i])
				}
				start = i + 1
			}
		}
	}

	curr := t.root
	accumSpecificity := 0

	for _, seg := range segments {
		kind := segLiteral
		literal := seg
		paramName := ""
		suffix := ""

		if seg == "**" {
			kind = segMultiWildcard
			paramName = "path"
			accumSpecificity += WeightMultiWildcard
		} else if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "...}") {
			kind = segMultiWildcard
			paramName = seg[1 : len(seg)-4]
			accumSpecificity += WeightMultiWildcard
		} else if strings.HasPrefix(seg, "*.") {
			kind = segSuffixWildcard
			suffix = seg[1:]
			accumSpecificity += WeightSuffixWild
		} else if seg == "*" {
			kind = segSingleWildcard
			accumSpecificity += WeightParamSingle
		} else if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			kind = segParam
			paramName = seg[1 : len(seg)-1]
			accumSpecificity += WeightParamSingle
		} else {
			kind = segLiteral
			literal = seg
			accumSpecificity += WeightLiteral
		}

		var child *routeNode
		switch kind {
		case segLiteral:
			child = curr.literalMap[literal]
			if child == nil {
				child = newRouteNode(kind, literal, paramName, suffix)
				child.specificity = accumSpecificity
				curr.literalMap[literal] = child
			}
		case segParam:
			if curr.paramChild == nil || curr.paramChild.paramName != paramName {
				child = newRouteNode(kind, literal, paramName, suffix)
				child.specificity = accumSpecificity
				curr.paramChild = child
			} else {
				child = curr.paramChild
			}
		case segSingleWildcard:
			if curr.wildChild == nil {
				child = newRouteNode(kind, literal, paramName, suffix)
				child.specificity = accumSpecificity
				curr.wildChild = child
			} else {
				child = curr.wildChild
			}
		case segSuffixWildcard:
			for _, sc := range curr.suffixChild {
				if sc.suffix == suffix {
					child = sc
					break
				}
			}
			if child == nil {
				child = newRouteNode(kind, literal, paramName, suffix)
				child.specificity = accumSpecificity
				curr.suffixChild = append(curr.suffixChild, child)
			}
		case segMultiWildcard:
			if curr.multiChild == nil {
				child = newRouteNode(kind, literal, paramName, suffix)
				child.specificity = accumSpecificity
				curr.multiChild = child
			} else {
				child = curr.multiChild
			}
		}

		curr = child
	}

	curr.policies = append(curr.policies, p)
	curr.host = host
	curr.specificity = accumSpecificity
	for _, m := range methods {
		if strings.TrimSpace(m) != "" {
			curr.methods[strings.ToUpper(strings.TrimSpace(m))] = struct{}{}
		}
	}
}

// Match finds all matching policies for the given method, path, and host.
func (t *RadixTree) Match(method string, path string, host string) []MatchedRoute {
	var dest [16]MatchedRoute
	return t.MatchInto(method, path, host, dest[:0])
}

type paramStack struct {
	params [4]RouteParam
	count  int
}

func cleanPathFast(path string) string {
	start := 0
	end := len(path)
	for start < end && path[start] == '/' {
		start++
	}
	for end > start && path[end-1] == '/' {
		end--
	}
	return path[start:end]
}

func toUpperFast(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'a' && s[i] <= 'z' {
			return strings.ToUpper(s)
		}
	}
	return s
}

// MatchInto finds matching policies without heap allocations when dest capacity is sufficient.
func (t *RadixTree) MatchInto(method string, path string, host string, dest []MatchedRoute) []MatchedRoute {
	clean := cleanPathFast(path)
	var segments [16]string
	segCount := 0

	if clean != "" {
		start := 0
		for i := 0; i < len(clean); i++ {
			if clean[i] == '/' {
				if i > start && segCount < len(segments) {
					segments[segCount] = clean[start:i]
					segCount++
				}
				start = i + 1
			}
		}
		if start < len(clean) && segCount < len(segments) {
			segments[segCount] = clean[start:]
			segCount++
		}
	}

	var pStack paramStack
	return t.matchRecursive(t.root, segments[:segCount], 0, toUpperFast(method), host, pStack, dest)
}

func (t *RadixTree) matchRecursive(curr *routeNode, segments []string, idx int, method string, host string, pStack paramStack, results []MatchedRoute) []MatchedRoute {
	if curr.kind == segMultiWildcard {
		matchedRemaining := strings.Join(segments[idx-1:], "/")
		if pStack.count > 0 && curr.paramName != "" {
			pStack.params[pStack.count-1].Value = matchedRemaining
		}

		if t.isTerminalMatch(curr, method, host) {
			for _, pol := range curr.policies {
				results = append(results, MatchedRoute{
					Policy:      pol,
					Params:      pStack.params,
					ParamCount:  pStack.count,
					Specificity: curr.specificity,
				})
			}
		}
		return results
	}

	if idx == len(segments) {
		if t.isTerminalMatch(curr, method, host) {
			for _, pol := range curr.policies {
				results = append(results, MatchedRoute{
					Policy:      pol,
					Params:      pStack.params,
					ParamCount:  pStack.count,
					Specificity: curr.specificity,
				})
			}
		}
		if curr.multiChild != nil && t.isTerminalMatch(curr.multiChild, method, host) {
			nextStack := pStack
			if nextStack.count < len(nextStack.params) {
				nextStack.params[nextStack.count] = RouteParam{Key: curr.multiChild.paramName, Value: ""}
				nextStack.count++
			}
			for _, pol := range curr.multiChild.policies {
				results = append(results, MatchedRoute{
					Policy:      pol,
					Params:      nextStack.params,
					ParamCount:  nextStack.count,
					Specificity: curr.multiChild.specificity,
				})
			}
		}
		return results
	}

	seg := segments[idx]

	// 1. Exact literal match (O(1) direct map lookup)
	if child := curr.literalMap[seg]; child != nil {
		results = t.matchRecursive(child, segments, idx+1, method, host, pStack, results)
	}

	// 2. Single param or single wildcard
	if curr.paramChild != nil {
		nextStack := pStack
		if nextStack.count < len(nextStack.params) {
			nextStack.params[nextStack.count] = RouteParam{Key: curr.paramChild.paramName, Value: seg}
			nextStack.count++
		}
		results = t.matchRecursive(curr.paramChild, segments, idx+1, method, host, nextStack, results)
	}
	if curr.wildChild != nil {
		results = t.matchRecursive(curr.wildChild, segments, idx+1, method, host, pStack, results)
	}

	// 3. Suffix wildcard
	for _, child := range curr.suffixChild {
		if strings.HasSuffix(seg, child.suffix) {
			results = t.matchRecursive(child, segments, idx+1, method, host, pStack, results)
		}
	}

	// 4. Multi-segment wildcard
	if curr.multiChild != nil {
		nextStack := pStack
		if nextStack.count < len(nextStack.params) {
			nextStack.params[nextStack.count] = RouteParam{Key: curr.multiChild.paramName, Value: seg}
			nextStack.count++
		}
		results = t.matchRecursive(curr.multiChild, segments, idx+1, method, host, nextStack, results)
	}

	return results
}

func (t *RadixTree) isTerminalMatch(node *routeNode, method string, host string) bool {
	if len(node.policies) == 0 {
		return false
	}
	if node.host != "" && host != "" && node.host != host {
		return false
	}
	if len(node.methods) > 0 {
		if _, ok := node.methods[method]; !ok {
			return false
		}
	}
	return true
}
