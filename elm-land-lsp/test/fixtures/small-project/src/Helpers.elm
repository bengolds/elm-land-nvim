module Helpers exposing (add, multiply, greet, clamp)


add : Int -> Int -> Int
add a b =
    a + b


multiply : Int -> Int -> Int
multiply a b =
    a * b


greet : String -> String
greet name =
    let
        greeting =
            "Hello"

        separator =
            ", "
    in
    greeting ++ separator ++ name ++ "!"


clamp : Int -> Int -> Int -> Int
clamp lo hi value =
    if value < lo then
        lo

    else if value > hi then
        hi

    else
        value
