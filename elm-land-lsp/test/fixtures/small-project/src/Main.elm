module Main exposing (main)

import Html exposing (Html, div, text)
import Helpers exposing (add, greet)
import Types exposing (Msg(..), Model)


main : Html msg
main =
    div []
        [ text (greet "World")
        , text (String.fromInt (add 1 2))
        ]


update : Msg -> Model -> Model
update msg model =
    case msg of
        Increment ->
            { model | count = model.count + 1 }

        Decrement ->
            { model | count = model.count - 1 }

        SetName name ->
            { model | name = name }
